/**
 * One event stream for all the viewer's tabs. A browser allows 6 connections per origin and the engine 16 streams,
 * so the tab that holds a Web Lock (the leader) opens `/api/v1/events` and relays every event over a
 * BroadcastChannel; the others follow. When the leader's tab closes, its lock is released and the next tab takes
 * over, resuming at the last cursor seen. Pages subscribe to `LiveMessage`s and read `LiveState`.
 */
import type { IngestStatus, PublicEvent, SseReady, SseResync } from "@quantext/shared";

export type Connection = "connecting" | "open" | "reconnecting";

export interface LiveState {
  role: "leader" | "follower";
  connection: Connection;
  /** The last change cursor seen. */
  cursor?: number;
  /** The id of the last event seen (`12` or `12.3`): where a new stream resumes. */
  resume?: string;
  ingest?: IngestStatus;
}

/** `event`: a change; `refresh`: events may have been missed, read what you show again (`since`: from a resync). */
export type LiveMessage = { type: "event"; event: PublicEvent } | { type: "refresh"; since?: number };

/** What a stream reports. `failed`: it dropped; it is opened again from the last event id. */
export interface StreamHandlers {
  open(): void;
  failed(): void;
  event(event: PublicEvent, id: string): void;
  resync(resync: SseResync): void;
  ready(ready: SseReady): void;
  ingest(status: IngestStatus): void;
}

export interface ChannelLike {
  onmessage: ((e: { data: unknown }) => void) | null;
  postMessage(data: unknown): void;
  close(): void;
}

export interface LiveDeps {
  /** `navigator.locks`, or undefined where there is none: then every tab opens its own stream. */
  locks: { request(name: string, run: () => Promise<void>): Promise<unknown> } | undefined;
  channel: ChannelLike;
  connect(resume: string | undefined, handlers: StreamHandlers): { close(): void };
  status(): Promise<IngestStatus>;
  /** The first wait before a failed stream is opened again; it doubles up to 30 s. */
  retryMs?: number;
}

export interface Live {
  state(): LiveState;
  subscribe(listener: (message: LiveMessage) => void): () => void;
  /** Subscribe to state changes (for `useSyncExternalStore`). */
  watch(listener: () => void): () => void;
  close(): void;
}

type Wire = { kind: "state"; state: LiveState } | { kind: "message"; message: LiveMessage } | { kind: "hello" };

const LOCK = "quantext-live-leader";
const MAX_RETRY_MS = 30_000;

export function createLive(deps: LiveDeps): Live {
  let state: LiveState = { role: "follower", connection: "connecting" };
  const listeners = new Set<(m: LiveMessage) => void>();
  const watchers = new Set<() => void>();
  let closed = false;
  let release: (() => void) | undefined;
  let stream: { close(): void } | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let retryMs = deps.retryMs ?? 1000;

  const setState = (next: Partial<LiveState>) => {
    state = { ...state, ...next };
    if (state.role === "leader") deps.channel.postMessage({ kind: "state", state } satisfies Wire);
    for (const w of watchers) w();
  };
  const deliver = (message: LiveMessage) => {
    for (const l of listeners) l(message);
  };
  const emit = (message: LiveMessage) => {
    deps.channel.postMessage({ kind: "message", message } satisfies Wire);
    deliver(message);
  };
  const seen = (cursor: number) => (state.cursor === undefined || cursor > state.cursor ? { cursor } : {});

  const handlers: StreamHandlers = {
    open: () => {
      retryMs = deps.retryMs ?? 1000;
      setState({ connection: "open" });
    },
    failed: () => {
      stream?.close();
      stream = undefined;
      setState({ connection: "reconnecting" });
      retryTimer = setTimeout(open, retryMs);
      retryMs = Math.min(2 * retryMs, MAX_RETRY_MS);
    },
    event: (event, id) => {
      setState({ ...seen(event.cursor), resume: id });
      emit({ type: "event", event });
    },
    resync: (resync) => {
      setState({ cursor: resync.cursor, resume: String(resync.cursor) });
      emit({ type: "refresh", since: resync.since });
    },
    ready: (ready) => {
      const fresh = state.resume === undefined;
      setState({ connection: "open", ...seen(ready.cursor), resume: String(ready.cursor) });
      if (fresh) emit({ type: "refresh" });
    },
    ingest: (status) => setState({ ingest: status }),
  };

  function open(): void {
    if (closed) return;
    stream = deps.connect(state.resume, handlers);
  }

  function lead(): Promise<void> {
    if (closed) return Promise.resolve();
    setState({ role: "leader" });
    deps.status().then(
      (ingest) => {
        if (state.ingest === undefined) setState({ ingest });
      },
      () => undefined, // the stream's own failure shows the connection state
    );
    open();
    return new Promise<void>((resolve) => {
      release = resolve;
    });
  }

  deps.channel.onmessage = ({ data }) => {
    const wire = data as Wire;
    if (wire.kind === "hello") {
      if (state.role === "leader") deps.channel.postMessage({ kind: "state", state } satisfies Wire);
    } else if (wire.kind === "state") {
      if (state.role === "follower") {
        const { role: _, ...shared } = wire.state;
        setState(shared);
      }
    } else if (state.role === "follower") deliver(wire.message);
  };
  deps.channel.postMessage({ kind: "hello" } satisfies Wire);
  if (deps.locks) void deps.locks.request(LOCK, lead);
  else void lead();

  return {
    state: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    watch(listener) {
      watchers.add(listener);
      return () => watchers.delete(listener);
    },
    close() {
      closed = true;
      clearTimeout(retryTimer);
      stream?.close();
      deps.channel.close();
      release?.();
    },
  };
}
