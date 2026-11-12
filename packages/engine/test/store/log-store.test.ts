import type { SessionDelta } from "@quantext/shared";
import { describe, expect, test } from "vitest";
import { claudeCodeCodec, createClaudeCodeParser } from "../../src/adapters/claude-code/index.ts";
import { emptyGraph, mergeDelta } from "../../src/core/graph.ts";
import type { LogStore, Store } from "../../src/store/index.ts";
import { openStore } from "../../src/store/index.ts";
import { scenarios, transcriptsOf } from "../fixtures.ts";
import { chunks, deltasOf, normal, random } from "./graph.ts";
import { onCleanup, tempDir } from "./temp.ts";

async function open(dataDir = tempDir()): Promise<Store> {
  const store = await openStore({ dataDir });
  onCleanup(() => store.close());
  return store;
}

const logOf = (store: Store, path = "/logs/a.jsonl"): LogStore => store.log(path, "claude-code", claudeCodeCodec);

describe.each(scenarios())("a log of $version/$name in the store", ({ name }) => {
  const input = transcriptsOf(name);
  const deltas = deltasOf(input);
  const merged = normal(deltas.reduce(mergeDelta, emptyGraph()));

  test("gives back the graph of the deltas written to it", async () => {
    const log = logOf(await open());
    for (const delta of deltas) log.write({ deltas: [delta] });
    expect(normal(log.graph())).toEqual(merged);
  });

  test("answers the parser's lookup, so a parser restored at random points goes on to the same graph", async () => {
    const store = await open();
    const log = logOf(store);
    const next = random(7);
    let parser = createClaudeCodeParser(undefined, { lookup: log.lookup });
    const apply = (delta: SessionDelta) => {
      log.write({ deltas: [delta] });
      if (next() < 0.3)
        parser = createClaudeCodeParser(JSON.parse(JSON.stringify(parser.snapshot())), { lookup: log.lookup });
    };
    for (const piece of chunks(input.main, next)) apply(parser.push(piece));
    apply(parser.flush());
    input.subagents.forEach((agent, i) => {
      const t = `subagent-${i}`;
      if (agent.meta !== undefined) apply(parser.pushMeta(t, agent.meta));
      for (const piece of chunks(agent.text, next)) apply(parser.push(piece, t));
      apply(parser.flush(t));
    });
    expect(normal(log.graph())).toEqual(merged);
  });
});

describe("writing to a log", () => {
  const deltas = deltasOf(transcriptsOf("basic-tools"));

  test("keeps the parser snapshot and the file marks with the rows, in one write", async () => {
    const log = logOf(await open());
    const mark = { path: "/logs/a.jsonl", transcript: "main", kind: "transcript" as const, size: 10, offset: 10 };
    log.write({ deltas, snapshot: { version: 1 }, files: [mark] });
    expect(log.snapshot()).toEqual({ version: 1 });
    expect(log.files()).toEqual([mark]);
  });

  test("keeps nothing of a write that fails", async () => {
    const log = logOf(await open());
    const broken = structuredClone(deltas[0] as SessionDelta);
    const run = broken.callBlocks[0];
    if (run !== undefined) run.blockHash = "no-such-block";
    expect(() => log.write({ deltas: [broken], snapshot: { version: 1 } })).toThrow();
    expect(log.snapshot()).toBeUndefined();
    expect(log.graph().calls).toEqual([]);
  });

  test("says which Calls each write added and which it updated, by Session", async () => {
    const log = logOf(await open());
    const parser = createClaudeCodeParser();
    const lines = transcriptsOf("basic-tools").main.split("\n");
    const request = lines.findIndex((l) => l.includes('"type":"api-request"'));
    const first = log.write({ deltas: [parser.push(`${lines.slice(0, request + 1).join("\n")}\n`)] });
    const session = "00000000-0000-4000-8000-000000000001";
    const id = first.calls[0]?.added[0];
    expect(first.calls).toEqual([{ sessionId: session, added: [id], updated: [] }]);
    const response = lines.findIndex((l, i) => i > request && l.includes('"type":"assistant"'));
    const second = log.write({ deltas: [parser.push(`${lines.slice(request + 1, response + 1).join("\n")}\n`)] });
    expect(second.calls).toEqual([{ sessionId: session, added: [], updated: [id] }]);
  });

  test("is idempotent: the same deltas again change no row", async () => {
    const store = await open();
    const log = logOf(store);
    log.write({ deltas });
    const before = normal(log.graph());
    const counts = rowCounts(store);
    log.write({
      deltas: deltas.map((d) => ({ ...d, report: { unknownRecords: [], ignoredRecords: [], unreadable: [] } })),
    });
    expect(normal(log.graph())).toEqual(before);
    expect(rowCounts(store)).toEqual(counts);
  });

  test("stores each content block once, and messages as lists of Block hashes", async () => {
    const store = await open();
    logOf(store).write({ deltas });
    const parts = store.db.prepare("SELECT blocks FROM messages").all();
    const hashes = new Set(parts.flatMap((r) => JSON.parse(String(r.blocks)) as string[]));
    expect(hashes.size).toBeGreaterThan(0);
    for (const hash of hashes)
      expect(store.db.prepare("SELECT 1 AS x FROM blocks WHERE hash = ?").get(hash)).toEqual({ x: 1 });
    const repeated = parts.reduce((n, r) => n + (JSON.parse(String(r.blocks)) as string[]).length, 0);
    expect(repeated).toBeGreaterThan(hashes.size); // messages repeat content that is stored once
  });

  test("sums the counts of unknown record kinds over writes and keeps unreadable lines in order", async () => {
    const log = logOf(await open());
    const report = (kind: string, at: string) => ({
      ...emptyGraph(),
      records: [],
      report: {
        unknownRecords: [{ kind, count: 2 }],
        ignoredRecords: [{ kind: `seen-${kind}`, count: 1 }],
        unreadable: [{ at, reason: "not JSON" }],
      },
    });
    log.write({ deltas: [report("x", "main:1"), report("y", "main:2"), report("x", "main:3")] });
    expect(log.graph().report).toEqual({
      unknownRecords: [
        { kind: "x", count: 4 },
        { kind: "y", count: 2 },
      ],
      ignoredRecords: [
        { kind: "seen-x", count: 2 },
        { kind: "seen-y", count: 1 },
      ],
      unreadable: ["main:1", "main:2", "main:3"].map((at) => ({ at, reason: "not JSON" })),
    });
  });
});

describe("the store keeps content small", () => {
  test("images as decoded bytes once in media, tool input by its Block, and no display text", async () => {
    const store = await open();
    const log = logOf(store);
    const deltas = deltasOf(transcriptsOf("image"));
    log.write({ deltas });
    const media = store.db.prepare("SELECT media_type, bytes FROM media").all();
    expect(media.map((m) => m.media_type)).toEqual(["image/png"]);
    const base64 = Buffer.from(media[0]?.bytes as Uint8Array).toString("base64");
    const holding = store.db.prepare("SELECT count(*) AS n FROM blocks WHERE instr(content, ?) > 0").get(base64);
    expect(holding).toEqual({ n: 0 });
    const inputs = store.db.prepare("SELECT input, block_hash FROM tool_calls").all();
    expect(inputs.length).toBeGreaterThan(0);
    expect(inputs.every((r) => r.input === null && r.block_hash !== null)).toBe(true);
    const columns = store.db
      .prepare("SELECT name FROM pragma_table_info('blocks')")
      .all()
      .map((r) => r.name);
    expect(columns).toEqual(["hash", "content"]);
    expect(normal(log.graph())).toEqual(normal(deltas.reduce(mergeDelta, emptyGraph())));
  });

  test("keeps each log's own kind and source of a Block that two logs share", async () => {
    const store = await open();
    const block = { hash: "b1", kind: "user" as const, source: {}, text: "hi", content: { type: "text", text: "hi" } };
    const delta = (kind: "user" | "reminder") => ({ ...emptyGraph(), records: [], blocks: [{ ...block, kind }] });
    const a = logOf(store, "/logs/a.jsonl");
    const b = logOf(store, "/logs/b.jsonl");
    a.write({ deltas: [delta("user")] });
    b.write({ deltas: [delta("reminder")] });
    expect(a.graph().blocks.map((x) => x.kind)).toEqual(["user"]);
    expect(b.graph().blocks.map((x) => x.kind)).toEqual(["reminder"]);
    expect(store.db.prepare("SELECT count(*) AS n FROM blocks").get()).toEqual({ n: 1 });
  });
});

describe("a log written by another adapter version", () => {
  test("is emptied when opened, to be read again from the start", async () => {
    const store = await open();
    const old = store.log("/logs/a.jsonl", "claude-code", { ...claudeCodeCodec, version: claudeCodeCodec.version - 1 });
    old.write({
      deltas: deltasOf(transcriptsOf("basic-tools")),
      snapshot: { version: 1 },
      files: [{ path: "/logs/a.jsonl", transcript: "main", kind: "transcript", size: 9, offset: 9 }],
    });
    const now = logOf(store);
    expect(now.graph()).toEqual(emptyGraph());
    expect(now.files()).toEqual([]);
    expect(now.snapshot()).toBeUndefined();
  });
});

describe("resetting a log", () => {
  test("removes its rows, report, file marks and snapshot, and leaves other logs alone", async () => {
    const store = await open();
    const a = logOf(store, "/logs/a.jsonl");
    const b = logOf(store, "/logs/b.jsonl");
    a.write({ deltas: deltasOf(transcriptsOf("basic-tools")), snapshot: { version: 1 } });
    b.write({ deltas: deltasOf(transcriptsOf("image")) });
    const other = normal(b.graph());
    a.reset();
    expect(a.graph()).toEqual(emptyGraph());
    expect(a.snapshot()).toBeUndefined();
    expect(a.files()).toEqual([]);
    expect(normal(b.graph())).toEqual(other);
    expect(store.logs()).toEqual(["/logs/a.jsonl", "/logs/b.jsonl"]);
  });
});

function rowCounts(store: Store): Record<string, number> {
  const tables = store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
  return Object.fromEntries(
    tables.map((t) => [
      String(t.name),
      Number(store.db.prepare(`SELECT count(*) AS n FROM "${String(t.name)}"`).get()?.n),
    ]),
  );
}
