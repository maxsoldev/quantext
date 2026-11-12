import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { claudeCodeCodec } from "../../src/adapters/claude-code/index.ts";
import type { CallsEvent, Ingest, IngestEvent } from "../../src/ingest/index.ts";
import { createIngest } from "../../src/ingest/index.ts";
import type { LogStore, Store } from "../../src/store/index.ts";
import { openStore } from "../../src/store/index.ts";
import { scenarios } from "../fixtures.ts";
import { normal, random } from "../store/graph.ts";
import { onCleanup, tempDir } from "../store/temp.ts";
import { copyScenario, expectedGraph, expectedScenario, layout, writeText } from "./corpus.ts";

interface Setup {
  root: string;
  dataDir: string;
  store: Store;
  ingest: Ingest;
  events: CallsEvent[];
}

async function setup(
  options: { root?: string; dataDir?: string; batchBytes?: number; restoreBytes?: number } = {},
): Promise<Setup> {
  const root = options.root ?? tempDir("qx-root-");
  const dataDir = options.dataDir ?? tempDir("qx-data-");
  const store = await openStore({ dataDir });
  onCleanup(() => store.close());
  const { batchBytes, restoreBytes } = options;
  const ingest = createIngest({
    store,
    root,
    ...(batchBytes === undefined ? {} : { batchBytes }),
    ...(restoreBytes === undefined ? {} : { restoreBytes }),
  });
  const events: CallsEvent[] = [];
  ingest.onCalls((e) => events.push(e));
  return { root, dataDir, store, ingest, events };
}

const graphOf = (store: Store, main: string) => normal(store.log(main, "claude-code", claudeCodeCodec).graph());

function rowCounts(store: Store): Record<string, number> {
  const tables = store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
  return Object.fromEntries(
    tables.map((t) => [
      String(t.name),
      Number(store.db.prepare(`SELECT count(*) AS n FROM "${String(t.name)}"`).get()?.n),
    ]),
  );
}

describe.each(scenarios())("ingest of $version/$name", ({ name }) => {
  test("from an empty store gives the adapter's graph of the scenario", async () => {
    const s = await setup();
    const files = copyScenario(s.root, name);
    const summary = await s.ingest.ingestAll();
    expect(summary.errors).toEqual([]);
    expect(graphOf(s.store, files.main)).toEqual(expectedScenario(files));
  });

  test("of a file that grows in pieces adds only new rows and ends with the same graph", async () => {
    const s = await setup();
    const files = layout(s.root, name);
    const next = random(11);
    const text = readFileSync(files.source);
    const added = new Set<string>();
    let rows = rowCounts(s.store);
    for (let at = 0; at < text.length; ) {
      const size = 1 + Math.floor(next() * 30000);
      writeText(files.main, text.subarray(0, at + size));
      at += size;
      await s.ingest.ingestAll();
      const now = rowCounts(s.store);
      for (const table of ["sessions", "calls", "call_blocks", "blocks"]) {
        expect(now[table]).toBeGreaterThanOrEqual(rows[table] ?? 0);
      }
      rows = now;
    }
    for (const e of s.events)
      for (const id of e.added) {
        expect(added.has(id)).toBe(false);
        added.add(id);
      }
    expect(graphOf(s.store, files.main)).toEqual(expectedGraph(text));
    expect(added.size).toBe(graphOf(s.store, files.main).calls.length);
  });

  test("goes on from its snapshot after the store is closed at a random point, also inside a line", async () => {
    for (const seed of [1, 2, 3]) {
      const root = tempDir("qx-root-");
      const dataDir = tempDir("qx-data-");
      const files = copyScenario(root, name);
      const text = readFileSync(files.source);
      const cut = Math.floor(random(seed)() * text.length);
      writeText(files.main, text.subarray(0, cut));
      const first = await openStore({ dataDir });
      await createIngest({ store: first, root }).ingestAll();
      first.close();
      writeText(files.main, text);
      const s = await setup({ root, dataDir });
      await s.ingest.ingestAll();
      expect(graphOf(s.store, files.main)).toEqual(expectedScenario(files));
    }
  });
});

test("logs that share content (one system prompt, one tool set) each give the graph they give alone", async () => {
  const s = await setup();
  const all = scenarios().map(({ name }) => copyScenario(s.root, name));
  await s.ingest.ingestAll();
  for (const files of all) expect(graphOf(s.store, files.main)).toEqual(expectedScenario(files));
  const stored = Number(s.store.db.prepare("SELECT count(DISTINCT hash) AS n FROM log_blocks").get()?.n);
  const reported = all.reduce((n, files) => n + graphOf(s.store, files.main).blocks.length, 0);
  expect(stored).toBeLessThan(reported); // shared Blocks are stored once
});

test("a new adapter version reads every log again from the start", async () => {
  const s = await setup();
  const files = copyScenario(s.root, "basic-tools");
  await s.ingest.ingestAll();
  const next = createIngest({
    store: s.store,
    root: s.root,
    codec: { ...claudeCodeCodec, version: claudeCodeCodec.version + 1 },
  });
  const summary = await next.ingestAll();
  expect(summary.bytes).toBe(readFileSync(files.main).length);
  expect(
    normal(
      s.store.log(files.main, "claude-code", { ...claudeCodeCodec, version: claudeCodeCodec.version + 1 }).graph(),
    ),
  ).toEqual(expectedScenario(files));
});

describe("reading again", () => {
  test("an unchanged corpus writes no row and reports no Call", async () => {
    const s = await setup();
    for (const { name } of scenarios()) copyScenario(s.root, name);
    await s.ingest.ingestAll();
    const counts = rowCounts(s.store);
    s.events.length = 0;
    const summary = await s.ingest.ingestAll();
    expect(rowCounts(s.store)).toEqual(counts);
    expect(s.events).toEqual([]);
    expect(summary.bytes).toBe(0);
  });

  test.each([
    ["a parser restored after each batch", 1],
    ["one parser for the whole file", Number.MAX_SAFE_INTEGER],
  ])("in batches much smaller than the file, with %s, gives the same graph", async (_, restoreBytes) => {
    const s = await setup({ batchBytes: 2048, restoreBytes });
    const files = copyScenario(s.root, "compaction");
    await s.ingest.ingestAll();
    expect(graphOf(s.store, files.main)).toEqual(expectedScenario(files));
  });
});

/** The store as seen by a process that dies after `writes` writes: every later write fails. */
function dyingStore(store: Store, writes: number): Store {
  let left = writes;
  return {
    ...store,
    log(path, harness, codec): LogStore {
      const log = store.log(path, harness, codec);
      return {
        ...log,
        write(batch) {
          if (left-- <= 0) throw new Error("the process died");
          return log.write(batch);
        },
      };
    },
  };
}

describe("an ingest that stops inside a file", () => {
  test.each([1, 3, 7])("after %i batches (the process died) goes on from there on the next start", async (k) => {
    const root = tempDir("qx-root-");
    const dataDir = tempDir("qx-data-");
    const files = copyScenario(root, "compaction");
    const first = await openStore({ dataDir });
    await expect(createIngest({ store: dyingStore(first, k), root, batchBytes: 4096 }).ingestAll()).rejects.toThrow(
      "the process died",
    );
    first.close();
    const s = await setup({ root, dataDir });
    await s.ingest.ingestAll();
    expect(graphOf(s.store, files.main)).toEqual(expectedScenario(files));
  });

  test("after a stop signal (shutdown, idle exit) goes on from there on the next start", async () => {
    const root = tempDir("qx-root-");
    const dataDir = tempDir("qx-data-");
    const files = copyScenario(root, "compaction");
    const first = await openStore({ dataDir });
    const ingest = createIngest({ store: first, root, batchBytes: 4096 });
    const stop = new AbortController();
    ingest.onCalls(() => stop.abort());
    const summary = await ingest.ingestAll({ signal: stop.signal });
    expect(summary.stopped).toBe(true);
    expect(summary.bytes).toBeLessThan(readFileSync(files.main).length);
    first.close();
    const s = await setup({ root, dataDir });
    await s.ingest.ingestAll();
    expect(graphOf(s.store, files.main)).toEqual(expectedScenario(files));
  });
});

/** The store, counting the lookups that a parser restored from its snapshot makes (its lanes' open runs). */
function countingStore(store: Store): { store: Store; restores: () => number } {
  let openRuns = 0;
  return {
    restores: () => openRuns,
    store: {
      ...store,
      log(path, harness, codec): LogStore {
        const log = store.log(path, harness, codec);
        return {
          ...log,
          lookup: {
            ...log.lookup,
            openRuns(sessionId, lane) {
              openRuns++;
              return log.lookup.openRuns(sessionId, lane);
            },
          },
        };
      },
    },
  };
}

describe("live ingest", () => {
  test("keeps the parser of a log warm between passes instead of restoring it each time", async () => {
    const root = tempDir("qx-root-");
    const files = layout(root, "basic-tools");
    const text = readFileSync(files.source);
    const half = text.indexOf("\n", text.length / 2) + 1;
    writeText(files.main, text.subarray(0, half));
    const real = await openStore({ dataDir: tempDir("qx-data-") });
    onCleanup(() => real.close());
    const counting = countingStore(real);
    const ingest = createIngest({ store: counting.store, root });
    await ingest.ingestAll();
    const before = counting.restores();
    writeText(files.main, text);
    await ingest.ingestAll();
    expect(counting.restores()).toBe(before);
    expect(graphOf(real, files.main)).toEqual(expectedGraph(text));
  });

  test("drops a warm parser whose write failed, so the next pass reads that batch again", async () => {
    const root = tempDir("qx-root-");
    const files = copyScenario(root, "compaction");
    const real = await openStore({ dataDir: tempDir("qx-data-") });
    onCleanup(() => real.close());
    let writes = 0;
    const flaky: Store = {
      ...real,
      log(path, harness, codec) {
        const log = real.log(path, harness, codec);
        return {
          ...log,
          write(batch) {
            if (++writes === 4) throw new Error("disk busy");
            return log.write(batch);
          },
        };
      },
    };
    const ingest = createIngest({ store: flaky, root, batchBytes: 4096 });
    expect((await ingest.ingestAll()).errors).toEqual([{ path: files.main, error: "ingest failed: disk busy" }]);
    await ingest.ingestAll();
    expect(graphOf(real, files.main)).toEqual(expectedScenario(files));
  });
});

describe("a file that changes under the reader", () => {
  test("truncated below the read position is read again from the start", async () => {
    const s = await setup();
    const files = copyScenario(s.root, "basic-tools");
    await s.ingest.ingestAll();
    const text = readFileSync(files.main);
    const half = text.subarray(0, text.indexOf("\n", text.length / 2) + 1);
    truncateSync(files.main, half.length);
    await s.ingest.ingestAll();
    expect(graphOf(s.store, files.main)).toEqual(expectedGraph(half));
    appendFileSync(files.main, text.subarray(half.length));
    await s.ingest.ingestAll();
    expect(graphOf(s.store, files.main)).toEqual(expectedGraph(text));
  });

  test("replaced by another file (a new inode) is read again from the start", async () => {
    const s = await setup();
    const files = copyScenario(s.root, "basic-tools");
    await s.ingest.ingestAll();
    const other = readFileSync(layout(s.root, "image").source);
    writeText(`${files.main}.new`, other);
    renameSync(`${files.main}.new`, files.main);
    await s.ingest.ingestAll();
    expect(graphOf(s.store, files.main)).toEqual(expectedGraph(other));
  });

  test("rewritten in place with other content of at least the same size is read again", async () => {
    const s = await setup();
    const files = copyScenario(s.root, "image");
    await s.ingest.ingestAll();
    const other = readFileSync(layout(s.root, "basic-tools").source);
    const inode = statSync(files.main).ino;
    writeFileSync(files.main, other); // same inode, truncated and written again
    expect(statSync(files.main).ino).toBe(inode);
    await s.ingest.ingestAll();
    expect(graphOf(s.store, files.main)).toEqual(expectedGraph(other));
  });
});

describe("a partial last line", () => {
  test("is not read until its newline comes, and is shown as pending", async () => {
    const s = await setup();
    const files = layout(s.root, "basic-tools");
    const text = readFileSync(files.source);
    const end = text.indexOf("\n", 5000) + 1;
    writeText(files.main, text.subarray(0, end + 25));
    await s.ingest.ingestAll();
    const report = s.store.report();
    expect(report.unreadable).toEqual([]);
    expect(report.files).toEqual([{ path: files.main, pendingBytes: 25 }]);
    writeText(files.main, text);
    await s.ingest.ingestAll();
    expect(s.store.report().files).toEqual([]);
    expect(graphOf(s.store, files.main)).toEqual(expectedGraph(text));
  });

  test("holds back a multi-byte character cut by the write, without breaking it", async () => {
    const s = await setup({ batchBytes: 64 });
    const main = join(s.root, "projects", "-p", "s.jsonl");
    const line = `${JSON.stringify({ type: "mode", sessionId: "s", text: "naïve ✓ ünïcödé".repeat(20) })}\n`;
    const bytes = Buffer.from(line.repeat(3));
    const cut = bytes.indexOf(Buffer.from("✓")) + 1;
    writeText(main, bytes.subarray(0, cut));
    await s.ingest.ingestAll();
    writeText(main, bytes);
    await s.ingest.ingestAll();
    expect(s.store.report().unreadable).toEqual([]);
    expect(graphOf(s.store, main)).toEqual(expectedGraph(bytes));
  });
});

describe("a line longer than the limit", () => {
  test("is skipped and reported, and the lines after it are read with their own numbers", async () => {
    const root = tempDir("qx-root-");
    const store = await openStore({ dataDir: tempDir("qx-data-") });
    onCleanup(() => store.close());
    const ingest = createIngest({ store, root, batchBytes: 1024, maxLineBytes: 4096 });
    const main = join(root, "projects", "-p", "00000000-0000-4000-8000-00000000abcd.jsonl");
    const row = (i: number) => JSON.stringify({ type: "attachment", sessionId: "s", n: i });
    const lines = [
      ...Array.from({ length: 40 }, (_, i) => row(i)),
      JSON.stringify({ type: "mode", sessionId: "s", text: "x".repeat(10_000) }),
      ...Array.from({ length: 40 }, (_, i) => row(40 + i)),
      "{not json",
      "",
    ];
    writeText(main, lines.join("\n"));
    await ingest.ingestAll();
    const start = Buffer.byteLength(`${lines.slice(0, 40).join("\n")}\n`);
    expect(store.report().unreadable).toEqual([
      { log: main, at: `main@${start}`, reason: "line is longer than 4096 bytes; skipped" },
      { log: main, at: "main:82", reason: expect.stringMatching(/^not JSON/) },
    ]);
    expect(graphOf(store, main).report.ignoredRecords).toEqual([{ kind: "attachment", count: 80 }]);
  });
});

describe("subagents", () => {
  test("that appear after the main transcript was read are linked to it", async () => {
    const s = await setup();
    const files = layout(s.root, "subagent");
    writeText(files.main, readFileSync(files.source));
    await s.ingest.ingestAll();
    for (const agent of files.subagents) {
      writeText(agent.path, readFileSync(agent.source));
      await s.ingest.ingestAll();
      if (agent.meta !== undefined && agent.sourceMeta !== undefined)
        writeText(agent.meta, readFileSync(agent.sourceMeta));
    }
    await s.ingest.ingestAll();
    const graph = graphOf(s.store, files.main);
    expect(graph.toolCalls.find((t) => t.name === "Agent")?.childSessionId).toMatch(/:agent-/);
    expect(graph.sessions).toHaveLength(2);
  });

  test("of a workflow (`subagents/workflows/<id>/`) are subagents of the session, not logs of their own", async () => {
    const s = await setup();
    const files = layout(s.root, "subagent");
    writeText(files.main, readFileSync(files.source));
    const agent = files.subagents[0];
    if (agent === undefined || agent.sourceMeta === undefined) throw new Error("the subagent scenario has a subagent");
    const dir = join(files.main.replace(/\.jsonl$/, ""), "subagents", "workflows", "wf-1");
    const name = agent.path.split("/").pop() ?? "";
    writeText(join(dir, name), readFileSync(agent.source));
    writeText(join(dir, name.replace(/\.jsonl$/, ".meta.json")), readFileSync(agent.sourceMeta));
    await s.ingest.ingestAll();
    expect(s.store.logs()).toEqual([files.main]);
    const expected = expectedGraph(readFileSync(files.source), [
      {
        name: `workflows/wf-1/${name.replace(/\.jsonl$/, "")}`,
        text: readFileSync(agent.source, "utf8"),
        meta: readFileSync(agent.sourceMeta, "utf8"),
      },
    ]);
    expect(graphOf(s.store, files.main)).toEqual(expected);
    expect(expected.sessions.find((x) => x.parentId !== undefined)).toBeDefined();
  });

  test("and the main transcript growing together give the same graph as one read", async () => {
    const s = await setup();
    const files = layout(s.root, "subagent");
    const main = readFileSync(files.source);
    const agent = files.subagents[0];
    if (agent === undefined) throw new Error("the subagent scenario has a subagent");
    const sub = readFileSync(agent.source);
    if (agent.meta !== undefined && agent.sourceMeta !== undefined)
      writeText(agent.meta, readFileSync(agent.sourceMeta));
    for (let i = 1; i <= 4; i++) {
      writeText(files.main, main.subarray(0, Math.floor((main.length * i) / 4)));
      writeText(agent.path, sub.subarray(0, Math.floor((sub.length * i) / 4)));
      await s.ingest.ingestAll();
    }
    expect(graphOf(s.store, files.main)).toEqual(expectedScenario(files));
  });
});

describe("errors", () => {
  test("a line that is not JSON is recorded in the report with its place", async () => {
    const s = await setup();
    const files = copyScenario(s.root, "basic-tools");
    const lines = readFileSync(files.main, "utf8").split("\n").length - 1;
    appendFileSync(files.main, "{not json\n");
    await s.ingest.ingestAll();
    expect(s.store.report().unreadable).toEqual([
      { log: files.main, at: `main:${lines + 1}`, reason: expect.stringMatching(/^not JSON/) },
    ]);
  });

  test.skipIf(process.getuid?.() === 0)("a file that cannot be read is reported, and read once it can", async () => {
    const s = await setup();
    const files = copyScenario(s.root, "basic-tools");
    chmodSync(files.main, 0o000);
    onCleanup(() => chmodSync(files.main, 0o644));
    const summary = await s.ingest.ingestAll();
    expect(summary.errors).toEqual([{ path: files.main, error: expect.stringMatching(/EACCES/) }]);
    expect(s.store.report().errors).toEqual([{ path: files.main, error: expect.stringMatching(/EACCES/) }]);
    chmodSync(files.main, 0o644);
    await s.ingest.ingestAll();
    expect(s.store.report().errors).toEqual([]);
    expect(graphOf(s.store, files.main)).toEqual(expectedScenario(files));
  });

  test.skipIf(process.getuid?.() === 0)(
    "symbolic links (not followed) and folders that cannot be read are kept in the report until a scan finds them gone",
    async () => {
      const s = await setup();
      const files = copyScenario(s.root, "basic-tools");
      const link = join(s.root, "projects", "-linked", "00000000-0000-4000-8000-00000000aaaa.jsonl");
      writeText(join(s.root, "elsewhere.jsonl"), "");
      mkdirSync(join(link, ".."), { recursive: true });
      symlinkSync(join(s.root, "elsewhere.jsonl"), link);
      const closed = join(s.root, "projects", "-closed");
      mkdirSync(closed);
      chmodSync(closed, 0o000);
      onCleanup(() => chmodSync(closed, 0o755));
      const summary = await s.ingest.ingestAll();
      const scan = [
        { path: closed, issue: expect.stringMatching(/EACCES/) },
        { path: link, issue: "a symbolic link; not followed" },
      ];
      expect(s.store.report().scan).toEqual(scan);
      expect(summary.errors).toEqual([{ path: closed, error: expect.stringMatching(/EACCES/) }]);
      chmodSync(closed, 0o755);
      rmSync(link);
      await s.ingest.ingestAll();
      expect(s.store.report().scan).toEqual([]);
      expect(graphOf(s.store, files.main)).toEqual(expectedScenario(files));
    },
  );

  test("unknown row types are counted in the report", async () => {
    const s = await setup();
    const files = copyScenario(s.root, "basic-tools");
    appendFileSync(files.main, `${JSON.stringify({ type: "brand-new-row", sessionId: "x" })}\n`.repeat(2));
    await s.ingest.ingestAll();
    expect(s.store.report().unknownRecords).toContainEqual({ kind: "brand-new-row", count: 2 });
  });
});

describe("the transcript folder", () => {
  test.skipIf(process.getuid?.() === 0)(
    "is only read: ingest works on a read-only folder and adds nothing to it",
    async () => {
      const s = await setup();
      const files = copyScenario(s.root, "subagent");
      const list = () =>
        readdirSync(s.root, { recursive: true, withFileTypes: true }).map((d) => {
          const path = join(d.parentPath, d.name);
          return [path, statSync(path).mtimeMs];
        });
      const before = list();
      const dirs = [
        s.root,
        ...readdirSync(s.root, { recursive: true, withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => join(d.parentPath, d.name)),
      ];
      for (const dir of dirs) chmodSync(dir, 0o555);
      onCleanup(() => {
        for (const dir of dirs) chmodSync(dir, 0o755);
      });
      expect((await s.ingest.ingestAll()).errors).toEqual([]);
      expect(list()).toEqual(before);
      expect(graphOf(s.store, files.main)).toEqual(expectedScenario(files));
    },
  );
});

test("the report counts sessions by whether their requests are in the log", async () => {
  const s = await setup();
  copyScenario(s.root, "subagent");
  writeText(
    join(s.root, "projects", "-old", "00000000-0000-4000-8000-0000000001d0.jsonl"),
    `${JSON.stringify({
      type: "assistant",
      sessionId: "00000000-0000-4000-8000-0000000001d0",
      message: {
        id: "msg_1",
        role: "assistant",
        model: "claude-opus-5-5",
        content: [],
        usage: { input_tokens: 5, output_tokens: 1 },
      },
    })}\n`,
  );
  await s.ingest.ingestAll();
  expect(s.store.report().requestLogs).toEqual([
    { requestLog: "absent", sessions: 1 },
    { requestLog: "present", sessions: 2 },
  ]);
});

describe("Calls events", () => {
  test("a listener that throws is reported, and neither ingest nor the other listeners stop", async () => {
    const s = await setup();
    const files = copyScenario(s.root, "basic-tools");
    s.ingest.onCalls(() => {
      throw new Error("listener broke");
    });
    const after: CallsEvent[] = [];
    s.ingest.onCalls((e) => after.push(e));
    const summary = await s.ingest.ingestAll();
    expect(summary.errors[0]).toEqual({ path: files.main, error: "a Calls listener failed: listener broke" });
    expect(after.length).toBe(s.events.length);
    expect(graphOf(s.store, files.main)).toEqual(expectedScenario(files));
  });

  test("name the Calls each read added and updated, by Session", async () => {
    const s = await setup();
    const files = copyScenario(s.root, "subagent");
    await s.ingest.ingestAll();
    const graph = graphOf(s.store, files.main);
    const sessions = new Set(s.events.map((e) => e.sessionId));
    expect(sessions).toEqual(new Set(graph.sessions.map((x) => x.id)));
    expect(s.events.every((e) => e.logId === 1)).toBe(true);
    expect(new Set(s.events.flatMap((e) => e.added))).toEqual(new Set(graph.calls.map((c) => c.id)));
  });

  test("tell when a log was emptied to be read again, and when memory changed, with the cursor", async () => {
    const s = await setup();
    const files = copyScenario(s.root, "image");
    const all: IngestEvent[] = [];
    s.ingest.onEvent((e) => all.push(e));
    await s.ingest.ingestAll();
    const text = readFileSync(files.source);
    writeText(files.main, text.subarray(0, text.indexOf("\n") + 1)); // cut below its read position: read again
    writeText(join(s.root, "projects", "-fixture-image", "memory", "MEMORY.md"), "note\n");
    await s.ingest.ingestAll();
    const removed = all.find((e) => e.kind === "log-removed");
    expect(removed).toMatchObject({ logId: 1, projects: ["/fixture-0000000000000000/repo"] });
    const memory = all.find((e) => e.kind === "memory");
    expect(memory).toMatchObject({ projectDirs: [join(s.root, "projects", "-fixture-image")] });
    const cursors = all.map((e) => e.cursor);
    expect(cursors).toEqual([...cursors].sort((a, b) => a - b));
    expect(all.filter((e) => e.kind === "calls").length).toBe(s.events.length);
  });

  test("carry the store's log id, the Calls' indexes and the change cursor after their write", async () => {
    const s = await setup();
    copyScenario(s.root, "basic-tools");
    await s.ingest.ingestAll();
    const cursors = s.events.map((e) => e.cursor);
    expect(cursors).toEqual([...cursors].sort((a, b) => a - b));
    expect(cursors.at(-1)).toBeLessThanOrEqual(s.store.changeCursor());
    expect(s.events.flatMap((e) => e.addedIndexes)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(new Set(s.events.map((e) => e.logId))).toEqual(new Set([1]));
  });
});
