/**
 * The engine's HTTP server on `node:http` (Node and Bun): `/health`, the JSON routes and the event stream under
 * `/api/v1/`, and the viewer's files. It binds 127.0.0.1 only, checks every request (`http.ts`), limits header
 * size, connections and time, and tells the caller when it was last used (idle exit).
 */
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import type {
  BlockLifetime,
  EngineStatus,
  Health,
  IngestEvent,
  IngestStatus,
  Items,
  LifetimeOptions,
  SessionKey,
  ToolOutput,
} from "@quantext/shared";
import type { Query } from "../query/index.ts";
import type { EventStream } from "./events.ts";
import { createEventStream } from "./events.ts";
import { refusal, sendBytes, sendError, sendJson } from "./http.ts";
import { badRequest, HttpError } from "./params.ts";
import { isInlineMedia, route } from "./routes.ts";
import { staticFiles } from "./static.ts";

const API_VERSION = 1;
const API_PREFIX = "/api/v1/";

/** Runs a slow query method off the event loop (a worker thread with its own connection and the same options). */
export interface Offload {
  (method: "blockLifetimes", key: SessionKey, options: LifetimeOptions): Promise<Items<BlockLifetime>>;
  (method: "toolOutputs", key: SessionKey, options: LifetimeOptions): Promise<Items<ToolOutput>>;
}

export interface ApiOptions {
  query: Query;
  /** What `/health` tells besides `ok` and `apiVersion`; `dataDir` is left out in demo mode. */
  info: Omit<Health, "ok" | "apiVersion">;
  /** The viewer's files. */
  staticDir: string;
  /** Where the lifetime routes run; by default on `query`, in this thread. */
  offload?: Offload;
  /** The ingest's status for `/api/v1/status`; by default live with nothing read. */
  ingestStatus?: () => IngestStatus;
  now?: () => number;
  /**
   * Open sockets at once; more are closed at once (default 64). Bun's node:http shows a socket only once it sent
   * a request, so there it counts those; Bun closes a silent socket by itself after about 10 s.
   */
  maxConnections?: number;
  /** A socket with no bytes for this long is closed; an open event stream is not (default 15 s). */
  idleSocketMs?: number;
  /** A request whose headers take longer is closed, however slowly they trickle in (default 10 s). */
  headersTimeoutMs?: number;
  /** Event stream settings (heartbeat, replay, slow-client limit, clients). */
  events?: Omit<Parameters<typeof createEventStream>[0], "query">;
  /** Gets a request that failed inside the engine (a 500); the default writes it to stderr. */
  onError?: (error: unknown) => void;
}

export interface Api {
  /** Listen on 127.0.0.1:`port` (0: any free port); returns the port. Fails with EADDRINUSE when it is taken. */
  listen(port: number): Promise<number>;
  /** Pass an ingest event on to the event streams. */
  publish(event: IngestEvent): void;
  /** Send the ingest status to the event streams (at most once a second). */
  publishIngest(status: IngestStatus): void;
  /** Event streams open now, and when the last request ended or the last stream closed (`now()` time). */
  activity(): { streams: number; lastActive: number };
  /** End the event streams, close every socket, stop listening. */
  close(): Promise<void>;
}

export function createApi(options: ApiOptions): Api {
  const { query } = options;
  const now = options.now ?? Date.now;
  const onError = options.onError ?? ((error: unknown) => console.error("quantext: a request failed:", error));
  const maxConnections = options.maxConnections ?? 64;
  const offload: Offload =
    options.offload ??
    (((method: "blockLifetimes" | "toolOutputs", key: SessionKey, o: LifetimeOptions) =>
      Promise.resolve(query[method](key, o))) as Offload);
  const files = staticFiles(options.staticDir);
  const events: EventStream = createEventStream({ query, onError, ...options.events });
  const { dataDir, ...info } = options.info;
  const health: Health = {
    apiVersion: API_VERSION,
    ok: true,
    ...info,
    ...(info.demo || dataDir === undefined ? {} : { dataDir }),
  };
  const ingestStatus =
    options.ingestStatus ??
    ((): IngestStatus => ({
      phase: "live",
      logsDone: 0,
      logsTotal: 0,
      bytesDone: 0,
      bytesTotal: 0,
      startedAt: info.startedAt,
    }));
  /** Demo mode shows that a read failed, not its path or message. */
  const shown = (s: IngestStatus): IngestStatus =>
    info.demo && s.lastError !== undefined ? { ...s, lastError: "a read failed (hidden in demo mode)" } : s;
  const status = (): EngineStatus => ({
    apiVersion: API_VERSION,
    engine: { version: info.version, pid: info.pid, startedAt: info.startedAt, demo: info.demo },
    ingest: shown(ingestStatus()),
    streams: events.clients(),
  });
  let port = 0;
  let lastActive = now();
  const sockets = new Set<Socket>();

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    let url: URL | undefined;
    try {
      url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
    } catch {
      url = undefined; // refused below, as the API (the strictest), or a 400
    }
    const api = url === undefined || url.pathname === "/api/v1" || url.pathname.startsWith("/api/");
    const refused = refusal(req, port, api || url?.pathname === "/health");
    if (refused !== undefined) return sendError(req, res, refused);
    if (url === undefined) throw badRequest("the URL is not one");
    const segments = decodeSegments(url.pathname);
    if (url.pathname === "/health") return sendJson(req, res, 200, health);
    // Only an answered request is activity: a mod polling /health does not keep the engine.
    const touch = () => {
      lastActive = now();
    };
    touch();
    // Bun tells a closed event stream on the request only, Node on both.
    req.on("close", touch);
    res.on("close", touch);
    if (url.pathname === "/api/v1/status") {
      if ([...url.searchParams.keys()].length > 0) throw badRequest("status takes no parameters");
      return sendJson(req, res, 200, status());
    }
    if (url.pathname === "/api/v1/events") {
      if (req.method !== "GET") throw new HttpError(405, "method-not-allowed", "the event stream is GET only");
      const header = req.headers["last-event-id"];
      const last = typeof header === "string" && header !== "" ? header : undefined;
      const cursor = url.searchParams.get("cursor") ?? last;
      for (const name of url.searchParams.keys()) {
        if (name !== "cursor") throw badRequest("the event stream takes only cursor");
      }
      req.socket.setTimeout(0); // a stream is quiet between heartbeats; its writes bound it instead
      return events.connect(req, res, cursor);
    }
    if (api) {
      if (!url.pathname.startsWith(API_PREFIX)) throw new HttpError(404, "not-found", "no such route");
      const reply = await route(query, segments.slice(2), url.searchParams, offload);
      if (reply.kind === "json") return sendJson(req, res, 200, reply.body);
      const inline = isInlineMedia(reply.mediaType);
      return sendBytes(
        req,
        res,
        reply.bytes,
        {
          "Content-Type": inline ? reply.mediaType : "application/octet-stream",
          "Cache-Control": "private, max-age=3600",
          ...(inline ? {} : { "Content-Disposition": "attachment" }),
        },
        false,
      );
    }
    const file = await files.get(segments);
    if (file === undefined) throw new HttpError(404, "not-found", "no such file");
    const cache = file.immutable ? "public, max-age=31536000, immutable" : "no-cache";
    return sendBytes(req, res, file.bytes, { "Content-Type": file.type, "Cache-Control": cache }, file.html);
  };

  const server: Server = createServer(
    // Header size, and time to send the headers and the request: a slow or huge request cannot hold a socket.
    {
      maxHeaderSize: 16 * 1024,
      headersTimeout: options.headersTimeoutMs ?? 10_000,
      requestTimeout: 30_000,
      keepAliveTimeout: 5_000,
      // How often Node checks the two limits above: without it, a slowloris gets 30 s more.
      connectionsCheckingInterval: 500,
    },
    (req, res) => {
      handle(req, res).catch((error: unknown) => {
        if (!(error instanceof HttpError)) onError(error);
        const failure = error instanceof HttpError ? error : new HttpError(500, "internal", "the engine failed");
        if (res.headersSent) res.destroy();
        else sendError(req, res, failure);
      });
    },
  );
  // A socket silent this long is destroyed (no "timeout" listener on the server): silent sockets cannot pile up.
  server.timeout = options.idleSocketMs ?? 15_000;
  server.on("connection", (socket: Socket) => {
    if (sockets.size >= maxConnections) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  return {
    listen(wanted) {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(wanted, "127.0.0.1", () => {
          server.off("error", reject);
          const address = server.address();
          port = typeof address === "object" && address !== null ? address.port : wanted;
          resolve(port);
        });
      });
    },
    publish: (event) => events.publish(event),
    publishIngest: (s) => events.publishIngest(shown(s)),
    activity: () => ({ streams: events.clients(), lastActive }),
    close() {
      events.close();
      return new Promise((resolve) => {
        server.close(() => resolve());
        for (const socket of sockets) socket.destroy();
      });
    },
  };
}

/** The path's segments, each percent-decoded once; a bad encoding is a 400. */
function decodeSegments(pathname: string): string[] {
  return pathname
    .split("/")
    .slice(1)
    .map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        throw badRequest("the path is not well encoded");
      }
    });
}
