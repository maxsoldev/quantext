/** The JSON routes over HTTP: one per query method, the same bodies as the query layer, strict parameters. */

import { connect } from "node:net";
import type { ApiError, Page, SessionSummary } from "@quantext/shared";
import { describe, expect, test } from "vitest";
import { engine, get } from "./client.ts";

const ID = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;

async function basic() {
  const e = await engine();
  const [key] = e.query.findSessions(ID(1));
  if (key === undefined) throw new Error("no session");
  const at = (path: string) => get(e.port, `/api/v1/sessions/${key.log}/${key.id}${path}`);
  return { ...e, key, at };
}

describe("the JSON routes", () => {
  test("give each query method's response as JSON, with apiVersion", async () => {
    const { port, query, key, at } = await basic();
    const sessions = await get(port, "/api/v1/sessions?limit=1&sort=calls");
    expect(sessions.status).toBe(200);
    expect(sessions.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(sessions.headers["cache-control"]).toBe("no-store");
    expect(sessions.json()).toEqual(JSON.parse(JSON.stringify(query.listSessions({ limit: 1, sort: "calls" }))));
    const cases: [string, unknown][] = [
      ["", query.getSession(key)],
      ["/calls?afterIndex=2&limit=3", query.listCalls(key, { afterIndex: 2, limit: 3 })],
      ["/calls/3", query.getCall(key, 3)],
      ["/calls/3/context", query.contextAt(key, 3)],
      ["/calls/3/diff", query.contextDiff(key, 3)],
      ["/timeline", query.callTimeline(key)],
      ["/tool-calls", query.toolCalls(key)],
      ["/tool-outputs?sort=tokens&limit=2", query.toolOutputs(key, { sort: "tokens", limit: 2 })],
      ["/blocks?limit=3", query.blockLifetimes(key, { limit: 3 })],
      ["/compactions", query.compactions(key)],
      ["/cache-breaks", query.cacheBreaks(key)],
    ];
    for (const [path, expected] of cases) {
      const reply = await at(path);
      expect([path, reply.status]).toEqual([path, 200]);
      expect(reply.json()).toEqual(JSON.parse(JSON.stringify(expected)));
      expect(reply.json().apiVersion).toBe(1);
    }
    expect((await get(port, "/api/v1/report")).json()).toEqual(JSON.parse(JSON.stringify(query.ingestReport())));
    expect((await get(port, `/api/v1/session-keys?id=${ID(1)}`)).json()).toEqual({
      apiVersion: 1,
      items: [key],
    });
  });

  test("give a Block and its media, an image inline and nothing else rendered", async () => {
    const { port, query } = await basic();
    const [image] = query.findSessions(ID(3));
    if (image === undefined) throw new Error("no image session");
    const block = query
      .contextAt(image, 1)
      ?.blocks.find((b) => b.source.filePath?.endsWith("diagram.png") && b.kind === "tool-result");
    if (block?.hash === undefined) throw new Error("no image block");
    const detail = await get(port, `/api/v1/blocks/${image.log}/${block.hash}`);
    expect(detail.json()).toEqual(JSON.parse(JSON.stringify(query.getBlock(block.hash, image.log))));
    const media = detail.json<{ media: { hash: string }[] }>().media[0];
    const bytes = await get(port, `/api/v1/blocks/${image.log}/${block.hash}/media/${media?.hash}`);
    expect(bytes.status).toBe(200);
    expect(bytes.headers["content-type"]).toBe("image/png");
    expect(bytes.headers["content-disposition"]).toBeUndefined();
    expect(bytes.headers["content-security-policy"]).toContain("sandbox");
    expect(bytes.bytes.subarray(1, 4).toString("latin1")).toBe("PNG");
  });

  test("the project memory, by project", async () => {
    const { port, query } = await basic();
    const reply = await get(port, "/api/v1/memory?project=repo");
    expect(reply.status).toBe(200);
    expect(reply.json()).toEqual(JSON.parse(JSON.stringify(query.projectMemory("repo"))));
  });

  test("lists the Sessions changed after a cursor", async () => {
    const { port } = await basic();
    const all = (await get(port, "/api/v1/sessions")).json<Page<SessionSummary>>();
    const changed = await get(port, `/api/v1/sessions?changedSince=${all.cursor}`);
    expect(changed.json<Page<SessionSummary>>().items).toEqual([]);
  });
});

describe("bad requests", () => {
  const bad: [string, string][] = [
    ["/api/v1/sessions?limit=0", "limit must be from 1 to 500"],
    ["/api/v1/sessions?limit=501", "limit must be from 1 to 500"],
    ["/api/v1/sessions?limit=-1", "limit must be a whole number"],
    ["/api/v1/sessions?limit=1.5", "limit must be a whole number"],
    ["/api/v1/sessions?limit=1e3", "limit must be a whole number"],
    ["/api/v1/sessions?offset=x", "offset must be a whole number"],
    ["/api/v1/sessions?sort=name", "sort must be one of ended, started, cost, calls"],
    ["/api/v1/sessions?order=up", "order must be one of asc, desc"],
    ["/api/v1/sessions?changedSince=9999999999999999", "changedSince must be a whole number"],
    ["/api/v1/sessions?limit=1&limit=2", "parameter limit is given more than once"],
    ["/api/v1/sessions?evil=1", "unknown parameter evil"],
    ["/api/v1/sessions?%3Cscript%3E=1", "unknown parameter (not shown)"],
    [`/api/v1/sessions?search=${"a".repeat(201)}`, "search must have 1 to 200 characters"],
    ["/api/v1/sessions?search=", "search must have 1 to 200 characters"],
    ["/api/v1/sessions?project=a%00b", "project must not hold control characters"],
    ["/api/v1/sessions/x/abc", "log must be a whole number"],
    ["/api/v1/sessions/1/%3Cimg%3E", "the session id is not one"],
    ["/api/v1/sessions/1/abc/calls/-1", "n must be a whole number"],
    ["/api/v1/blocks/1/XYZ", "hash must be a hex hash"],
    ["/api/v1/memory", "project is needed"],
    ["/api/v1/session-keys", "id is needed"],
    ["/api/v1/sessions/1/%E0%A4%A", "the path is not well encoded"],
    ["/api/v1/events?cursor=abc", "cursor must be an event id (12 or 12.3)"],
    ["/api/v1/events?since=1", "the event stream takes only cursor"],
  ];
  test("are refused with 400 and a JSON error that names the parameter, not its value", async () => {
    const { port } = await engine(["basic-tools"]);
    for (const [path, message] of bad) {
      const reply = await get(port, path);
      expect([path, reply.status, reply.json<ApiError>().error]).toEqual([
        path,
        400,
        { status: 400, code: "bad-request", message },
      ]);
      expect(reply.headers["content-type"]).toBe("application/json; charset=utf-8");
      expect(reply.body).not.toContain("<");
    }
  });

  test("404 for an unknown route, Session, Call, Block or media", async () => {
    const { port, key, at } = await basic();
    const missing = [
      "/api/v1/nothing",
      "/api/v1",
      "/api/v2/sessions",
      `/api/v1/sessions/${key.log + 5}/${key.id}`,
      `/api/v1/sessions/${key.log}/no-such-session/calls`,
      `/api/v1/sessions/${key.log}/no-such-session/timeline`,
      `/api/v1/blocks/${key.log}/${"0".repeat(64)}`,
      `/api/v1/blocks/${key.log}/${"0".repeat(64)}/media/${"0".repeat(64)}`,
    ];
    for (const path of missing) {
      const reply = await get(port, path);
      expect([path, reply.status, reply.json<ApiError>().error.code]).toEqual([path, 404, "not-found"]);
    }
    expect((await at("/calls/999")).status).toBe(404);
    expect((await at("/calls/999/context")).status).toBe(404);
  });
});

describe("demo mode", () => {
  test("no route shows a hidden project", async () => {
    const plain = await basic();
    const hash = plain.query.contextAt(plain.key, 1)?.blocks.find((b) => b.hash !== undefined)?.hash;
    const { port } = await engine(
      ["basic-tools", "image"],
      {},
      { demo: { projects: ["/no/such"], redactPaths: true } },
    );
    const sessions = (await get(port, "/api/v1/sessions")).json<Page<SessionSummary>>();
    expect([sessions.total, sessions.items, sessions.redacted]).toEqual([0, [], true]);
    const { log, id } = plain.key;
    for (const path of [
      `/api/v1/sessions/${log}/${id}`,
      `/api/v1/sessions/${log}/${id}/calls`,
      `/api/v1/sessions/${log}/${id}/calls/1/context`,
      `/api/v1/sessions/${log}/${id}/timeline`,
      `/api/v1/sessions/${log}/${id}/tool-outputs`,
      `/api/v1/blocks/${log}/${hash}`,
    ]) {
      expect([path, (await get(port, path)).status]).toEqual([path, 404]);
    }
    expect((await get(port, `/api/v1/session-keys?id=${id}`)).json()).toEqual({ apiVersion: 1, items: [] });
  });
});

describe("/api/v1/status", () => {
  const status = {
    phase: "catching-up" as const,
    logsDone: 2,
    logsTotal: 7,
    bytesDone: 10,
    bytesTotal: 99,
    startedAt: "2026-11-12T00:00:01.000Z",
    lastError: "projects/x.jsonl: EACCES",
  };

  test("tells the engine, its ingest and its streams", async () => {
    const { port } = await engine(["basic-tools"], { ingestStatus: () => status });
    expect((await get(port, "/api/v1/status")).json()).toEqual({
      apiVersion: 1,
      engine: { version: "0.0.0-test", pid: process.pid, startedAt: "2026-11-12T00:00:00.000Z", demo: false },
      ingest: status,
      streams: 0,
    });
  });

  test("in demo mode, only that a read failed", async () => {
    const info = { version: "0.0.0-test", pid: 1, startedAt: "2026-11-12T00:00:00.000Z", demo: true };
    const { port } = await engine(["basic-tools"], { info, ingestStatus: () => status });
    const reply = (await get(port, "/api/v1/status")).json<{ ingest: { lastError: string } }>();
    expect(reply.ingest.lastError).toBe("a read failed (hidden in demo mode)");
  });
});

describe("activity, for the idle exit", () => {
  test("counts the requests it answers, not /health and not refused ones", async () => {
    let clock = 1000;
    const { port, api } = await engine(["basic-tools"], { now: () => clock });
    const since = api.activity().lastActive;
    clock = 2000;
    await get(port, "/health");
    await get(port, "/api/v1/sessions", { host: "evil.example" });
    await get(port, "/api/v1/sessions", { origin: "https://evil.example" });
    expect(api.activity().lastActive).toBe(since);
    clock = 3000;
    await get(port, "/api/v1/sessions");
    expect(api.activity().lastActive).toBe(3000);
  });

  test("decides what is the API by the parsed path", async () => {
    const { port } = await engine(["basic-tools"]);
    // An absolute-form target names the API too: it is checked as the API, so a navigation from elsewhere is refused.
    // Raw sockets: Bun's HTTP client hangs on a second absolute-form request on one connection.
    const send = (headers: string) =>
      new Promise<string>((resolve) => {
        let out = "";
        const socket = connect({ host: "127.0.0.1", port }, () =>
          socket.write(
            `GET http://127.0.0.1:${port}/api/v1/sessions HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n` +
              `Connection: close\r\n${headers}\r\n`,
          ),
        );
        socket.on("data", (d: Buffer) => (out += d.toString("utf8")));
        socket.on("close", () => resolve(out));
      });
    const navigation = "Sec-Fetch-Site: cross-site\r\nSec-Fetch-Mode: navigate\r\nSec-Fetch-Dest: document\r\n";
    expect(await send(navigation)).toMatch(/^HTTP\/1\.1 403 /);
    expect(await send("")).toMatch(/^HTTP\/1\.1 200 [\s\S]*"apiVersion":1/);
  });
});
