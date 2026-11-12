/**
 * The engine's HTTP server on `node:http` (Node and Bun): `/health`, the JSON routes and the event stream under
 * `/api/v1/`, and the viewer's files. It binds 127.0.0.1 only, checks every request (`http.ts`), limits header
 * size, connections and time, and tells the caller when it was last used (idle exit).
 */
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import type { Health, IngestEvent } from "@quantext/shared";
import type { Query } from "../query/index.ts";
import type { EventStream } from "./events.ts";
import { createEventStream } from "./events.ts";
import { refusal, sendBytes, sendError, sendJson } from "./http.ts";
import { badRequest, HttpError } from "./params.ts";
import { isInlineMedia, route } from "./routes.ts";
import { staticFiles } from "./static.ts";

const API_VERSION = 1;
const API_PREFIX = "/api/v1/";

export interface ApiOptions {
  query: Query;
  /** What `/health` tells besides `ok` and `apiVersion`; `dataDir` is left out in demo mode. */
  info: Omit<Health, "ok" | "apiVersion">;
  /** The viewer's files. */
  staticDir: string;
  now?: () => number;
  /** Open sockets at once; more are closed at once (default 64). */
  maxConnections?: number;
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
  const files = staticFiles(options.staticDir);
  const events: EventStream = createEventStream({ query, onError, ...options.events });
  const { dataDir, ...info } = options.info;
  const health: Health = {
    apiVersion: API_VERSION,
    ok: true,
    ...info,
    ...(info.demo || dataDir === undefined ? {} : { dataDir }),
  };
  let port = 0;
  let lastActive = now();
  const sockets = new Set<Socket>();

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const raw = req.url ?? "/";
    const api = raw.startsWith(API_PREFIX) || raw === "/api/v1" || raw.startsWith("/api/");
    const refused = refusal(req, port, api || raw.startsWith("/health"));
    if (refused !== undefined) return sendError(req, res, refused);
    const url = parseUrl(raw, port);
    const segments = decodeSegments(url.pathname);
    if (url.pathname === "/health") return sendJson(req, res, 200, health);
    if (url.pathname === "/api/v1/events") {
      if (req.method !== "GET") throw new HttpError(405, "method-not-allowed", "the event stream is GET only");
      const header = req.headers["last-event-id"];
      const last = typeof header === "string" && header !== "" ? header : undefined;
      const cursor = url.searchParams.get("cursor") ?? last;
      for (const name of url.searchParams.keys()) {
        if (name !== "cursor") throw badRequest("the event stream takes only cursor");
      }
      return events.connect(req, res, cursor);
    }
    if (api) {
      if (!url.pathname.startsWith(API_PREFIX)) throw new HttpError(404, "not-found", "no such route");
      const reply = route(query, segments.slice(2), url.searchParams);
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
    { maxHeaderSize: 16 * 1024, headersTimeout: 10_000, requestTimeout: 30_000, keepAliveTimeout: 5_000 },
    (req, res) => {
      lastActive = now();
      res.on("close", () => {
        lastActive = now();
      });
      handle(req, res).catch((error: unknown) => {
        if (!(error instanceof HttpError)) onError(error);
        const failure = error instanceof HttpError ? error : new HttpError(500, "internal", "the engine failed");
        if (res.headersSent) res.destroy();
        else sendError(req, res, failure);
      });
    },
  );
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

/** The request target as a URL; `..` and `%2e%2e` segments are resolved away by the URL parser. */
function parseUrl(raw: string, port: number): URL {
  try {
    return new URL(raw, `http://127.0.0.1:${port}`);
  } catch {
    throw badRequest("the URL is not one");
  }
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
