/**
 * The SSE stream of change events (`GET /api/v1/events`). Each ingest event goes through the query layer's
 * `visibleEvent` (demo mode), is kept in a ring of recent events, and is written to every client. A client that
 * comes back with a cursor gets what it missed from the ring, or `resync` when the ring no longer holds it. A
 * client that does not read is dropped once its unsent bytes pass a limit: memory never grows with a slow client.
 * The replay is written in parts, each after the last one drained, so a long replay never trips that limit.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { IngestEvent, SseReady, SseResync, VisibleEvent } from "@quantext/shared";
import type { Query } from "../query/index.ts";
import { securityHeaders } from "./http.ts";
import { badRequest } from "./params.ts";

const API_VERSION = 1;

export interface EventStreamOptions {
  query: Query;
  /** A comment line this often, so that proxies and the browser keep the stream (default 15 s). */
  heartbeatMs?: number;
  /** Events kept for clients that reconnect (default 1024). */
  replayEvents?: number;
  /** A client with more unsent bytes than this is dropped (default 1 MiB). */
  maxBufferedBytes?: number;
  /** Clients at once; more get 503 (default 16). */
  maxClients?: number;
  /** A client whose replay does not drain in this time is dropped (default 30 s). */
  drainTimeoutMs?: number;
  /** Gets a failure to pass an event on; its clients are closed so that they reconnect and resync. */
  onError?: (error: unknown) => void;
}

export interface EventStream {
  /** Pass an ingest event on to the clients that may see it. */
  publish(event: IngestEvent): void;
  /** Serve one client: replay from `cursor` (Last-Event-ID or `?cursor=`), then live events. */
  connect(req: IncomingMessage, res: ServerResponse, cursor: string | undefined): void;
  clients(): number;
  /** End every stream. */
  close(): void;
}

/** A place in the stream: every event up to cursor `c`, and of cursor `c` up to ordinal `o` (one write can give several). */
interface Position {
  c: number;
  o: number;
}

interface Kept extends Position {
  event: VisibleEvent;
}

const after = (a: Position, b: Position) => a.c > b.c || (a.c === b.c && a.o > b.o);

/** `12` (all of cursor 12) or `12.3` (cursor 12 up to its ordinal 3), as the event ids are written. */
export function parseCursor(text: string): Position {
  const m = /^(\d{1,15})(?:\.(\d{1,6}))?$/.exec(text);
  if (m === null) throw badRequest("cursor must be an event id (12 or 12.3)");
  return { c: Number(m[1]), o: m[2] === undefined ? Number.POSITIVE_INFINITY : Number(m[2]) };
}

export function createEventStream(options: EventStreamOptions): EventStream {
  const { query } = options;
  const heartbeatMs = options.heartbeatMs ?? 15_000;
  const replayEvents = options.replayEvents ?? 1024;
  const maxBuffered = options.maxBufferedBytes ?? 1024 * 1024;
  const maxClients = options.maxClients ?? 16;
  const onError = options.onError ?? ((error: unknown) => console.error("quantext: an event was not sent:", error));
  const drainTimeoutMs = options.drainTimeoutMs ?? 30_000;
  /** Each stream, and whether it is live (else its replay is still being written). */
  const clients = new Map<ServerResponse, { live: boolean }>();
  const ring: Kept[] = [];
  /** Clients at or after this place can be replayed from the ring. */
  let floor: Position = { c: query.changeCursor(), o: Number.POSITIVE_INFINITY };
  let latest = floor.c;

  const drop = (res: ServerResponse) => {
    clients.delete(res);
    res.destroy();
  };
  /** A live write: a client with more unsent bytes than the limit does not read, and is dropped. */
  const write = (res: ServerResponse, text: string) => {
    if (res.destroyed) return;
    res.write(text);
    if (res.writableLength > maxBuffered) drop(res);
  };
  /** Resolves when `res` drained (true), or closed or timed out (false). */
  const drained = (res: ServerResponse) =>
    new Promise<boolean>((resolve) => {
      const done = (ok: boolean) => {
        clearTimeout(timer);
        res.off("drain", onDrain);
        res.off("close", onClose);
        resolve(ok);
      };
      const onDrain = () => done(true);
      const onClose = () => done(false);
      const timer = setTimeout(() => done(false), drainTimeoutMs);
      res.on("drain", onDrain);
      res.on("close", onClose);
    });
  /**
   * Write the ring after `from`, a part at a time, then `ready`, and make the client live. Events that come
   * meanwhile go to the ring and are written by this loop, so the order holds.
   */
  const replay = async (res: ServerResponse, from: Position | undefined, head: string) => {
    let text = head;
    let at = from;
    let replayed = 0;
    for (;;) {
      if (at !== undefined && after(floor, at)) {
        drop(res); // the ring moved past it while it read slowly: it reconnects and resyncs
        return;
      }
      const next = at === undefined ? [] : ring.filter((k) => after(k, at as Position));
      if (next.length === 0) break;
      for (const k of next) {
        text += eventFrame(k);
        at = k;
        replayed++;
        if (text.length >= 16 * 1024 || k === next.at(-1)) {
          if (res.destroyed) return;
          const ok = res.write(text);
          text = "";
          if ((!ok || res.writableLength > maxBuffered / 2) && !(await drained(res))) {
            if (!res.destroyed) drop(res);
            return;
          }
        }
      }
    }
    if (res.destroyed) return;
    const ready: SseReady = { apiVersion: API_VERSION, cursor: latest, replayed };
    res.write(text + frame("ready", String(latest), ready));
    const state = clients.get(res);
    if (state !== undefined) state.live = true;
  };
  const frame = (name: string, id: string, data: unknown) =>
    `id: ${id}\nevent: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
  const eventFrame = (k: Kept) => frame(k.event.kind, `${k.c}.${k.o}`, k.event);

  const heartbeat = setInterval(() => {
    for (const [res, state] of clients) if (state.live) write(res, ": ping\n\n");
  }, heartbeatMs);
  heartbeat.unref();

  return {
    publish(event) {
      let shown: VisibleEvent | null;
      try {
        shown = query.visibleEvent(event);
      } catch (error) {
        // Clients that come back must not think they missed nothing.
        floor = { c: Math.max(floor.c, event.cursor), o: Number.POSITIVE_INFINITY };
        latest = Math.max(latest, event.cursor);
        for (const res of clients.keys()) res.end();
        clients.clear();
        onError(error);
        return;
      }
      latest = Math.max(latest, event.cursor);
      if (shown === null) return;
      const last = ring.at(-1);
      const kept: Kept = { c: event.cursor, o: last?.c === event.cursor ? last.o + 1 : 0, event: shown };
      ring.push(kept);
      if (ring.length > replayEvents) {
        const dropped = ring.shift() as Kept;
        floor = { c: dropped.c, o: dropped.o };
      }
      const text = eventFrame(kept);
      for (const [res, state] of clients) if (state.live) write(res, text);
    },
    connect(req, res, cursorText) {
      const from = cursorText === undefined ? undefined : parseCursor(cursorText);
      if (clients.size >= maxClients) {
        res.writeHead(503, {
          ...securityHeaders(false),
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
          "Retry-After": "5",
        });
        res.end(
          JSON.stringify({
            apiVersion: API_VERSION,
            error: { status: 503, code: "too-many-streams", message: "too many event streams are open" },
          }),
        );
        return;
      }
      res.writeHead(200, {
        ...securityHeaders(false),
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      clients.set(res, { live: false });
      const gone = () => clients.delete(res);
      req.on("close", gone);
      res.on("close", gone);
      let head = "retry: 2000\n\n";
      let start = from;
      if (from !== undefined && (from.c > latest || after(floor, from))) {
        const resync: SseResync = { apiVersion: API_VERSION, cursor: latest, since: from.c > latest ? 0 : from.c };
        head += frame("resync", String(latest), resync);
        start = undefined;
      }
      replay(res, start, head).catch((error: unknown) => {
        drop(res);
        onError(error);
      });
    },
    clients: () => clients.size,
    close() {
      clearInterval(heartbeat);
      for (const res of clients.keys()) res.end();
      clients.clear();
    },
  };
}
