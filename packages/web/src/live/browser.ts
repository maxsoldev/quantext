/** The page's Live: EventSource on `/api/v1/events`, a BroadcastChannel, and Web Locks for the leader. */
import type { IngestStatus, PublicEvent, SseReady, SseResync } from "@quantext/shared";
import { api } from "../api/client.ts";
import type { ChannelLike, Live, StreamHandlers } from "./live.ts";
import { createLive } from "./live.ts";

function connect(resume: string | undefined, h: StreamHandlers): { close(): void } {
  const url = resume === undefined ? "/api/v1/events" : `/api/v1/events?cursor=${encodeURIComponent(resume)}`;
  const source = new EventSource(url);
  // Any drop: close and open again from our own last id, so the resume point is always the one we track.
  source.onopen = () => h.open();
  source.onerror = () => {
    source.close();
    h.failed();
  };
  const on = <T>(name: string, fn: (data: T, id: string) => void) =>
    source.addEventListener(name, (e) =>
      fn(JSON.parse((e as MessageEvent<string>).data) as T, (e as MessageEvent).lastEventId),
    );
  for (const name of ["calls", "memory", "log-removed"]) on<PublicEvent>(name, (data, id) => h.event(data, id));
  on<SseResync>("resync", (data) => h.resync(data));
  on<SseReady>("ready", (data) => h.ready(data));
  on<IngestStatus>("ingest", (data) => h.ingest(data));
  return { close: () => source.close() };
}

const broadcast = new BroadcastChannel("quantext-live");
const channel: ChannelLike = {
  onmessage: null,
  postMessage: (data) => broadcast.postMessage(data),
  close: () => broadcast.close(),
};
broadcast.onmessage = (e) => channel.onmessage?.(e);

export const live: Live = createLive({
  locks: typeof navigator !== "undefined" && "locks" in navigator ? navigator.locks : undefined,
  channel,
  connect,
  status: async () => (await api.status()).ingest,
});

addEventListener("pagehide", () => live.close());
