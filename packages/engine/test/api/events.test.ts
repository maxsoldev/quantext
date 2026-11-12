/** The SSE stream over HTTP: ready, live events, replay from a cursor, resync, heartbeats, slow clients, demo mode. */
import type { ClientRequest } from "node:http";
import { request } from "node:http";
import { connect } from "node:net";
import type { SseReady, SseResync } from "@quantext/shared";
import { describe, expect, test } from "vitest";
import { callsEvent, engine, get } from "./client.ts";

const ID = "00000000-0000-4000-8000-000000000001";

interface Frame {
  id?: string;
  event?: string;
  data?: string;
  comment?: string;
}

/** An open event stream: its frames as they come, and whether the server ended it. */
interface Stream {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  frames: Frame[];
  ended: boolean;
  /** Wait until a frame matches (2 s at most). */
  until(match: (f: Frame) => boolean): Promise<Frame>;
  /** Wait until the server ends the stream. */
  end(): Promise<void>;
  close(): void;
}

function parse(block: string): Frame {
  const f: Frame = {};
  for (const line of block.split("\n")) {
    if (line.startsWith(":")) f.comment = line.slice(1).trim();
    const m = /^(id|event|data): (.*)$/.exec(line);
    if (m !== null) f[m[1] as "id" | "event" | "data"] = m[2] ?? "";
  }
  return f;
}

function open(port: number, path = "/api/v1/events", headers: Record<string, string> = {}): Promise<Stream> {
  return new Promise((resolve, reject) => {
    let req: ClientRequest | undefined;
    req = request(
      { host: "127.0.0.1", port, path, headers: { host: `127.0.0.1:${port}`, ...headers }, agent: false },
      (res) => {
        let buffer = "";
        const waiters: (() => void)[] = [];
        const wake = () => {
          for (const w of waiters.splice(0)) w();
        };
        const stream: Stream = {
          status: res.statusCode ?? 0,
          headers: res.headers,
          frames: [],
          ended: false,
          until(match) {
            return new Promise((done, fail) => {
              const timer = setTimeout(
                () => fail(new Error(`no such frame in ${JSON.stringify(stream.frames)}`)),
                2000,
              );
              const check = () => {
                const found = stream.frames.find(match);
                if (found !== undefined) {
                  clearTimeout(timer);
                  done(found);
                } else if (stream.ended) {
                  clearTimeout(timer);
                  fail(new Error(`the stream ended: ${JSON.stringify(stream.frames)}`));
                } else waiters.push(check);
              };
              check();
            });
          },
          end() {
            return new Promise((done) => {
              const check = () => (stream.ended ? done() : waiters.push(check));
              check();
            });
          },
          close: () => req?.destroy(),
        };
        res.on("data", (chunk: Buffer) => {
          buffer += chunk.toString("utf8");
          let at = buffer.indexOf("\n\n");
          while (at >= 0) {
            stream.frames.push(parse(buffer.slice(0, at)));
            buffer = buffer.slice(at + 2);
            at = buffer.indexOf("\n\n");
          }
          wake();
        });
        const ended = () => {
          stream.ended = true;
          wake();
        };
        res.on("end", ended);
        res.on("close", ended);
        res.on("error", ended);
        resolve(stream);
      },
    );
    req.on("error", reject);
    req.end();
  });
}

const ready = (f: Frame) => f.event === "ready";
const data = <T>(f: Frame) => JSON.parse(f.data ?? "null") as T;

async function setup(options: Parameters<typeof engine>[1] = {}, queryOptions: Parameters<typeof engine>[2] = {}) {
  const e = await engine(["basic-tools"], options, queryOptions);
  const key = e.query.findSessions(ID)[0] ?? { log: 1, id: ID };
  const cursor = e.query.changeCursor();
  return { ...e, key, cursor };
}

describe("the event stream", () => {
  test("opens with ready at the store's cursor, then sends each new Call as it is written", async () => {
    const { port, api, key, cursor, query } = await setup();
    const stream = await open(port);
    expect(stream.status).toBe(200);
    expect(stream.headers["content-type"]).toBe("text/event-stream; charset=utf-8");
    expect(stream.headers["cache-control"]).toBe("no-store");
    const first = await stream.until(ready);
    expect(first.id).toBe(String(cursor));
    expect(data<SseReady>(first)).toEqual({ apiVersion: 1, cursor, replayed: 0 });
    expect(api.activity().streams).toBe(1);
    const event = callsEvent(key.log, key.id, cursor + 1, 8);
    api.publish(event);
    const calls = await stream.until((f) => f.event === "calls");
    expect(calls.id).toBe(`${cursor + 1}.0`);
    expect(data(calls)).toEqual(query.visibleEvent(event));
    expect(data(calls)).toMatchObject({ kind: "calls", session: key, added: [{ index: 8 }] });
    stream.close();
  });

  test("replays what a client missed after its cursor (Last-Event-ID or ?cursor=), then goes on live", async () => {
    const { port, api, key, cursor } = await setup();
    api.publish(callsEvent(key.log, key.id, cursor + 1, 1));
    api.publish(callsEvent(key.log, key.id, cursor + 2, 2));
    api.publish(callsEvent(key.log, key.id, cursor + 2, 3)); // one write, two Sessions' Calls
    const ids = (s: Stream) => s.frames.filter((f) => f.event === "calls").map((f) => f.id);

    const all = await open(port, `/api/v1/events?cursor=${cursor}`);
    expect(data<SseReady>(await all.until(ready))).toEqual({ apiVersion: 1, cursor: cursor + 2, replayed: 3 });
    expect(ids(all)).toEqual([`${cursor + 1}.0`, `${cursor + 2}.0`, `${cursor + 2}.1`]);
    expect((await all.until(ready)).id).toBe(String(cursor + 2));

    const some = await open(port, "/api/v1/events", { "last-event-id": `${cursor + 2}.0` });
    await some.until(ready);
    expect(ids(some)).toEqual([`${cursor + 2}.1`]);

    const none = await open(port, `/api/v1/events?cursor=${cursor + 2}`);
    expect(data<SseReady>(await none.until(ready)).replayed).toBe(0);

    api.publish(callsEvent(key.log, key.id, cursor + 3, 4));
    for (const s of [all, some, none]) {
      expect((await s.until((f) => f.id === `${cursor + 3}.0`)).event).toBe("calls");
      s.close();
    }
  });

  test("asks a client to resync when its cursor is older than what it holds, or unknown", async () => {
    const { port, api, key, cursor } = await setup({ events: { replayEvents: 2 } });
    const resync = async (path: string) => {
      const s = await open(port, path);
      const f = await s.until((x) => x.event === "resync");
      await s.until(ready);
      s.close();
      return { id: f.id, ...data<SseResync>(f) };
    };
    // Before the engine started: the ring never held it.
    expect(await resync(`/api/v1/events?cursor=${cursor - 1}`)).toEqual({
      id: String(cursor),
      apiVersion: 1,
      cursor,
      since: cursor - 1,
    });
    // Beyond the store's cursor: another store, or an engine that read more; read everything again.
    expect(await resync(`/api/v1/events?cursor=${cursor + 50}`)).toMatchObject({ since: 0 });
    for (let i = 1; i <= 3; i++) api.publish(callsEvent(key.log, key.id, cursor + i, i));
    // The ring keeps the last 2: cursor + 1 fell out.
    expect(await resync(`/api/v1/events?cursor=${cursor}`)).toMatchObject({ cursor: cursor + 3, since: cursor });
    const kept = await open(port, `/api/v1/events?cursor=${cursor + 1}`);
    expect(data<SseReady>(await kept.until(ready)).replayed).toBe(2);
    kept.close();
  });

  test("sends a heartbeat comment", async () => {
    const { port } = await setup({ events: { heartbeatMs: 20 } });
    const stream = await open(port);
    expect((await stream.until((f) => f.comment === "ping")).comment).toBe("ping");
    stream.close();
  });

  test("drops a client that does not read, without holding its bytes", async () => {
    const { port, api, key, cursor } = await setup({ events: { maxBufferedBytes: 64 * 1024 } });
    const socket = connect({ host: "127.0.0.1", port }, () => {
      socket.write(`GET /api/v1/events HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`);
      socket.pause(); // never reads
    });
    socket.on("error", () => socket.destroy());
    while (api.activity().streams === 0) await new Promise((r) => setTimeout(r, 5));
    const reader = await open(port);
    await reader.until(ready);
    const big = { ...callsEvent(key.log, key.id, 0), added: Array.from({ length: 200 }, (_, i) => `call-${i}`) };
    let n = 0;
    while (api.activity().streams === 2 && n < 5000) {
      n++;
      api.publish({ ...big, cursor: cursor + n });
      await new Promise((r) => setTimeout(r, 0)); // the reader reads between events
    }
    expect(api.activity().streams).toBe(1); // the slow one is gone, the reader stays
    await reader.until((f) => f.id === `${cursor + n}.0`);
    reader.close();
    socket.destroy();
  });

  test("refuses streams beyond its limit with 503", async () => {
    const { port } = await setup({ events: { maxClients: 1 } });
    const one = await open(port);
    await one.until(ready);
    const two = await get(port, "/api/v1/events");
    expect([two.status, two.json<{ error: { code: string } }>().error.code]).toEqual([503, "too-many-streams"]);
    one.close();
  });

  test("passes on only what demo mode shows", async () => {
    const { port, api, cursor } = await setup({}, { demo: { projects: ["/no/such/project"], redactPaths: true } });
    const key = { log: 1, id: ID }; // the one log ingested; demo mode hides it
    const stream = await open(port);
    await stream.until(ready);
    api.publish(callsEvent(key.log, key.id, cursor + 1));
    api.publish({ kind: "log-removed", logId: key.log, cursor: cursor + 2, projects: ["/fixture/repo"] });
    api.publish({ kind: "memory", cursor: cursor + 3, projectDirs: ["/anywhere"] });
    // A frame after them proves they were not sent: the stream is in order.
    const later = await open(port, `/api/v1/events?cursor=${cursor}`);
    expect(data<SseReady>(await later.until(ready))).toMatchObject({ cursor: cursor + 3, replayed: 0 });
    expect(stream.frames.filter((f) => f.event !== undefined && f.event !== "ready")).toEqual([]);
    stream.close();
    later.close();
  });

  test("closes a client's streams when an event cannot be shown, so that it resyncs", async () => {
    const { port, api, key, cursor, errors } = await setup();
    const stream = await open(port);
    await stream.until(ready);
    // An event the query layer fails on (here: one with no Calls list).
    api.publish({ ...callsEvent(key.log, key.id, cursor + 1), added: undefined } as never);
    await stream.end();
    expect(errors).toHaveLength(1);
    const again = await open(port, `/api/v1/events?cursor=${cursor}`);
    expect((await again.until((f) => f.event === "resync")).event).toBe("resync");
    again.close();
  });

  test("ends every stream when the server closes", async () => {
    const { port, api } = await setup();
    const stream = await open(port);
    await stream.until(ready);
    await api.close();
    await stream.end();
    expect(stream.ended).toBe(true);
  });
});
