/**
 * The HTTP API's own types (docs/api.md): health, errors, the SSE stream's control events, and the engine file
 * that names a running engine. The routes' bodies are the query layer's response types (`query.ts`).
 */
import type { ApiVersion, Meta } from "./query.ts";

/** `GET /health`: the engine that answers. */
export interface Health extends Meta {
  ok: true;
  /** The engine's version: a second start reuses an engine of the same version only. */
  version: string;
  pid: number;
  /** ISO 8601. */
  startedAt: string;
  /** The data folder. */
  dataDir?: string;
}

/** How far the pass in progress (or the last one) has read: of the logs and bytes it found new, how many it read. */
export interface IngestProgress {
  logsDone: number;
  logsTotal: number;
  bytesDone: number;
  bytesTotal: number;
  /** When the pass started (ISO 8601). */
  startedAt: string;
}

/** The engine's ingest: catching up after its start, then live, then stopping. */
export interface IngestStatus extends IngestProgress {
  phase: "catching-up" | "live" | "stopping";
  /** The last read that failed. */
  lastError?: string;
}

/** `GET /api/v1/status`: the engine, its ingest, its open event streams. */
export interface EngineStatus extends Meta {
  engine: { version: string; pid: number; startedAt: string };
  ingest: IngestStatus;
  streams: number;
}

/** SSE `ingest`: the ingest status, at most once a second while it changes; it has no id. */
export interface SseIngest extends IngestStatus {
  apiVersion: ApiVersion;
}

/** The body of every 4xx and 5xx response of the API. */
export interface ApiError {
  apiVersion: ApiVersion;
  error: {
    /** The HTTP status. */
    status: number;
    /** A stable word: `bad-request`, `not-found`, `method-not-allowed`, `forbidden`, … */
    code: string;
    /** For people; it never repeats the request's input. */
    message: string;
  };
}

/** SSE `ready`: the replay is done; live events follow. Its id is the cursor, to resume from. */
export interface SseReady {
  apiVersion: ApiVersion;
  cursor: number;
  /** Events replayed after the client's cursor. */
  replayed: number;
}

/**
 * SSE `resync`: the events after the client's cursor are no longer held (or the cursor is unknown). Read
 * `GET /api/v1/sessions?changedSince=<since>` again; `cursor` is where the stream goes on from.
 */
export interface SseResync {
  apiVersion: ApiVersion;
  cursor: number;
  since: number;
}

/** `engine.json` in the data folder: where the running engine listens. A hint; the writer lock is the guarantee. */
export interface EngineFile {
  apiVersion: ApiVersion;
  version: string;
  pid: number;
  port: number;
  url: string;
  startedAt: string;
}
