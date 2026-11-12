import type { IngestStatus, PublicEvent } from "@quantext/shared";
import { describe, expect, test } from "vitest";
import type { LiveDeps, LiveMessage, StreamHandlers } from "./live.ts";
import { createLive } from "./live.ts";

/** Web Locks for one lock name: the first request holds it until its callback settles, then the next. */
class FakeLocks {
  private queue: { run: () => Promise<void>; done: () => void }[] = [];
  private busy = false;
  request(_name: string, run: () => Promise<void>): Promise<void> {
    return new Promise((done) => {
      this.queue.push({ run, done });
      this.next();
    });
  }
  private next(): void {
    if (this.busy) return;
    const head = this.queue.shift();
    if (!head) return;
    this.busy = true;
    head.run().finally(() => {
      this.busy = false;
      head.done();
      this.next();
    });
  }
}

/** A BroadcastChannel bus: a message reaches every other member, not the sender. */
class Bus {
  members = new Set<{ onmessage: ((e: { data: unknown }) => void) | null }>();
  channel() {
    const bus = this;
    const member = {
      onmessage: null as ((e: { data: unknown }) => void) | null,
      postMessage(data: unknown) {
        for (const m of bus.members) if (m !== member) queueMicrotask(() => m.onmessage?.({ data }));
      },
      close() {
        bus.members.delete(member);
      },
    };
    this.members.add(member);
    return member;
  }
}

interface OpenStream {
  resume: string | undefined;
  handlers: StreamHandlers;
  closed: boolean;
}

const LIVE: IngestStatus = {
  phase: "live",
  logsDone: 2,
  logsTotal: 2,
  bytesDone: 10,
  bytesTotal: 10,
  startedAt: "2026-11-12T00:00:00Z",
};

function tab(locks: FakeLocks, bus: Bus, streams: OpenStream[]) {
  const deps: LiveDeps = {
    locks,
    channel: bus.channel(),
    connect(resume, handlers) {
      const s: OpenStream = { resume, handlers, closed: false };
      streams.push(s);
      return { close: () => (s.closed = true) };
    },
    status: async () => LIVE,
    retryMs: 1,
  };
  const live = createLive(deps);
  const got: LiveMessage[] = [];
  live.subscribe((m) => got.push(m));
  return { live, got };
}

const settle = () => new Promise((r) => setTimeout(r, 5));

const calls = (cursor: number): PublicEvent => ({
  kind: "calls",
  cursor,
  session: { log: 1, id: "s" },
  added: [{ id: "c", index: 0 }],
  updated: [],
});

describe("one event stream shared by the tabs", () => {
  test("only the first tab opens a stream; the others get its events", async () => {
    const locks = new FakeLocks();
    const bus = new Bus();
    const streams: OpenStream[] = [];
    const a = tab(locks, bus, streams);
    const b = tab(locks, bus, streams);
    await settle();
    expect(streams).toHaveLength(1);
    expect(a.live.state().role).toBe("leader");
    expect(b.live.state().role).toBe("follower");
    streams[0]?.handlers.open();
    streams[0]?.handlers.event(calls(5), "5.0");
    await settle();
    for (const t of [a, b]) expect(t.got).toContainEqual({ type: "event", event: calls(5) });
    expect(b.live.state()).toMatchObject({ connection: "open", cursor: 5 });
  });

  test("when the leader closes, the next tab takes over and resumes at the last cursor", async () => {
    const locks = new FakeLocks();
    const bus = new Bus();
    const streams: OpenStream[] = [];
    const a = tab(locks, bus, streams);
    const b = tab(locks, bus, streams);
    await settle();
    streams[0]?.handlers.open();
    streams[0]?.handlers.event(calls(9), "9.0");
    await settle();
    a.live.close();
    await settle();
    expect(streams[0]?.closed).toBe(true);
    expect(streams).toHaveLength(2);
    expect(streams[1]?.resume).toBe("9.0");
    expect(b.live.state().role).toBe("leader");
  });

  test("a stream that fails is opened again from the last cursor", async () => {
    const locks = new FakeLocks();
    const streams: OpenStream[] = [];
    const a = tab(locks, new Bus(), streams);
    await settle();
    streams[0]?.handlers.open();
    streams[0]?.handlers.event(calls(3), "3.0");
    streams[0]?.handlers.failed();
    expect(a.live.state().connection).toBe("reconnecting");
    await settle();
    expect(streams[0]?.closed).toBe(true);
    expect(streams[1]?.resume).toBe("3.0");
  });
});

describe("what the stream tells the pages", () => {
  test("a resync asks every tab to read again, and moves the cursor on", async () => {
    const locks = new FakeLocks();
    const bus = new Bus();
    const streams: OpenStream[] = [];
    const a = tab(locks, bus, streams);
    const b = tab(locks, bus, streams);
    await settle();
    streams[0]?.handlers.resync({ apiVersion: 1, cursor: 40, since: 12 });
    await settle();
    for (const t of [a, b]) expect(t.got).toContainEqual({ type: "refresh", since: 12 });
    expect(a.live.state()).toMatchObject({ cursor: 40, resume: "40" });
  });

  test("a stream opened with no cursor asks the pages to read again once it is ready", async () => {
    const streams: OpenStream[] = [];
    const a = tab(new FakeLocks(), new Bus(), streams);
    await settle();
    expect(streams[0]?.resume).toBeUndefined();
    streams[0]?.handlers.ready({ apiVersion: 1, cursor: 7, replayed: 0 });
    expect(a.got).toContainEqual({ type: "refresh" });
    expect(a.live.state().cursor).toBe(7);
  });

  test("ingest progress is shared state, starting from the engine's status", async () => {
    const locks = new FakeLocks();
    const bus = new Bus();
    const streams: OpenStream[] = [];
    const a = tab(locks, bus, streams);
    const b = tab(locks, bus, streams);
    await settle();
    expect(a.live.state().ingest).toEqual(LIVE);
    const catching: IngestStatus = { ...LIVE, phase: "catching-up", logsDone: 1 };
    streams[0]?.handlers.ingest(catching);
    await settle();
    expect(b.live.state().ingest).toEqual(catching);
  });

  test("a tab that opens late gets the current state from the leader", async () => {
    const locks = new FakeLocks();
    const bus = new Bus();
    const streams: OpenStream[] = [];
    tab(locks, bus, streams);
    await settle();
    streams[0]?.handlers.open();
    streams[0]?.handlers.event(calls(21), "21.0");
    await settle();
    const late = tab(locks, bus, streams);
    await settle();
    expect(late.live.state()).toMatchObject({ role: "follower", connection: "open", cursor: 21, ingest: LIVE });
  });
});
