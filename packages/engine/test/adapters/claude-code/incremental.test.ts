import type { SessionDelta, SessionGraph } from "@quantext/shared";
import { describe, expect, test } from "vitest";
import type { ClaudeCodeTranscripts } from "../../../src/adapters/claude-code/index.ts";
import { createClaudeCodeParser, parseClaudeCodeSession } from "../../../src/adapters/claude-code/index.ts";
import { emptyGraph, mergeDelta } from "../../../src/core/graph.ts";
import { scenarios, transcriptsOf } from "../../fixtures.ts";
import { MemoryStore } from "./memory-store.ts";
import { syntheticSession } from "./synthetic.ts";

/** A small deterministic random number generator, so a failing chunking can be found again. */
function random(seed: number): () => number {
  let x = seed;
  return () => {
    x = (x * 1103515245 + 12345) % 2147483648;
    return x / 2147483648;
  };
}

/** Cut a text into pieces of random length, many of them inside a line. */
function chunks(text: string, next: () => number): string[] {
  const out: string[] = [];
  for (let at = 0; at < text.length; ) {
    const size = 1 + Math.floor(next() * (next() < 0.5 ? 40 : 4000));
    out.push(text.slice(at, at + size));
    at += size;
  }
  return out;
}

/** The graph in a fixed order, so that two ways of reading can be compared. */
function normal(graph: SessionGraph): SessionGraph {
  const by =
    <T>(key: (x: T) => string) =>
    (a: T, b: T) =>
      key(a).localeCompare(key(b));
  return {
    sessions: [...graph.sessions].sort(by((s) => s.id)),
    calls: [...graph.calls].sort(by((c) => c.id)),
    blocks: [...graph.blocks].sort(by((b) => b.hash)),
    callBlocks: [...graph.callBlocks].sort(by((r) => r.id)),
    toolCalls: [...graph.toolCalls].sort(by((t) => t.id)),
    compactions: [...graph.compactions].sort(by((c) => c.id)),
    events: [...graph.events].sort(by((e) => e.id)),
    report: graph.report,
  };
}

/** Read the transcripts in random pieces: the main transcript, then each subagent with its meta file. */
function readInChunks(input: ClaudeCodeTranscripts, seed: number): SessionGraph {
  const next = random(seed);
  const parser = createClaudeCodeParser();
  let graph = emptyGraph();
  const add = (delta: SessionDelta) => {
    graph = mergeDelta(graph, delta);
  };
  for (const piece of chunks(input.main, next)) add(parser.push(piece));
  add(parser.flush());
  input.subagents.forEach((agent, i) => {
    const name = `subagent-${i}`;
    if (agent.meta !== undefined) add(parser.pushMeta(name, agent.meta));
    for (const piece of chunks(agent.text, next)) add(parser.push(piece, name));
    add(parser.flush(name));
  });
  return graph;
}

describe.each(scenarios())("incremental parse of $version/$name", ({ name }) => {
  const input = transcriptsOf(name);
  const whole = normal(parseClaudeCodeSession(input));

  test.each([1, 2, 3, 4, 5])("random pieces (seed %i) give the same graph as one read", (seed) => {
    expect(normal(readInChunks(input, seed))).toEqual(whole);
  });

  test.each([1, 2, 3])(
    "restored from JSON snapshots at random points (seed %i), it goes on to the same graph",
    (seed) => {
      const next = random(seed);
      const store = new MemoryStore();
      let parser = createClaudeCodeParser(undefined, { lookup: store });
      const maybeRestore = () => {
        if (next() < 0.3)
          parser = createClaudeCodeParser(JSON.parse(JSON.stringify(parser.snapshot())), { lookup: store });
      };
      for (const piece of chunks(input.main, next)) {
        store.apply(parser.push(piece));
        maybeRestore();
      }
      store.apply(parser.flush());
      input.subagents.forEach((agent, i) => {
        const name = `subagent-${i}`;
        if (agent.meta !== undefined) store.apply(parser.pushMeta(name, agent.meta));
        for (const piece of chunks(agent.text, next)) {
          store.apply(parser.push(piece, name));
          maybeRestore();
        }
        store.apply(parser.flush(name));
      });
      expect(normal(store.graph())).toEqual(whole);
    },
  );
});

describe("a growing transcript", () => {
  const { main } = transcriptsOf("basic-tools");

  test("holds back a last line without a newline instead of reporting it as unreadable", () => {
    const parser = createClaudeCodeParser();
    const lines = main.split("\n");
    const cut = lines.slice(0, 20).join("\n");
    const delta = parser.push(`${cut}\n${(lines[20] ?? "").slice(0, 30)}`);
    expect(delta.report.unreadable).toEqual([]);
    const rest = parser.push(`${(lines[20] ?? "").slice(30)}\n`);
    expect(rest.report.unreadable).toEqual([]);
  });

  test("updates an earlier Call when its response arrives", () => {
    const parser = createClaudeCodeParser();
    const lines = main.split("\n");
    const request = lines.findIndex((l) => l.includes('"type":"api-request"'));
    const before = parser.push(`${lines.slice(0, request + 1).join("\n")}\n`);
    expect(before.calls[0]?.usage).toBeUndefined();
    expect(before.calls[0]?.issues.map((i) => i.kind)).toEqual(["no-usage"]);
    const response = lines.findIndex((l, i) => i > request && l.includes('"type":"assistant"'));
    const after = parser.push(`${lines.slice(request + 1, response + 1).join("\n")}\n`);
    expect(after.calls.map((c) => [c.index, c.usage?.outputTokens, c.issues])).toEqual([[0, 86, []]]);
    expect(after.callBlocks.length).toBeGreaterThan(0);
  });

  test("fills an earlier ToolCall when its result arrives", () => {
    const parser = createClaudeCodeParser();
    const lines = main.split("\n");
    const result = lines.findIndex((l) => l.includes('"tool_result"'));
    const before = parser.push(`${lines.slice(0, result).join("\n")}\n`);
    expect(before.toolCalls[0]?.durationMs).toBeUndefined();
    const after = parser.push(`${lines[result]}\n`);
    expect(after.toolCalls.map((t) => t.durationMs)).toEqual([55]);
  });
});

describe("rows that come late", () => {
  const { main } = transcriptsOf("basic-tools");
  const lines = main.split("\n").filter((l) => l !== "");
  /** Move the line that matches `what` to just after the line that matches `after`. */
  const moveAfter = (what: (l: string) => boolean, after: (l: string) => boolean) => {
    const from = lines.findIndex(what);
    const moved = lines.filter((_, i) => i !== from);
    const to = moved.findIndex(after);
    return [...moved.slice(0, to + 1), lines[from] ?? "", ...moved.slice(to + 1)].join("\n") + "\n";
  };
  const whole = normal(parseClaudeCodeSession({ main, subagents: [] }));
  const blob = "57f8db8649716b6b1a1f14bfb320331edaae432d80df2b5b26ed801af4679fa3";

  test("a blob written after its request resolves the waiting call", () => {
    const late = moveAfter(
      (l) => l.includes('"type":"api-request-blob"') && l.includes(blob),
      (l) => l.includes('"type":"api-request"') && l.includes(blob),
    );
    expect(normal(parseClaudeCodeSession({ main: late, subagents: [] }))).toEqual(whole);
  });

  test("a blob written after the response too resolves the call and splits it then", () => {
    const late = moveAfter(
      (l) => l.includes('"type":"api-request-blob"') && l.includes(blob),
      (l) => l.includes('"requestRef":"5810d630') && l.includes('"type":"assistant"'),
    );
    expect(normal(parseClaudeCodeSession({ main: late, subagents: [] }))).toEqual(whole);
  });

  test("a shape written after the first request resolves it", () => {
    const late = moveAfter(
      (l) => l.includes('"type":"api-request-shape"'),
      (l) => l.includes('"type":"api-request"'),
    );
    expect(normal(parseClaudeCodeSession({ main: late, subagents: [] }))).toEqual(whole);
  });
});

describe("the snapshot", () => {
  test.each([500, 2000, 5000])("of a %i-call session holds only the open frontier: under 200 kB", (calls) => {
    const store = new MemoryStore();
    const parser = createClaudeCodeParser(undefined, { lookup: store });
    store.apply(parser.push(syntheticSession(calls)));
    expect(JSON.stringify(parser.snapshot()).length).toBeLessThan(200_000);
  });

  test("of a long session restores and goes on with the next call as if never stopped", () => {
    const text = syntheticSession(600).split("\n");
    const cut = text.findIndex((l, i) => i > 900 && l.includes('"type":"api-request"'));
    const whole = new MemoryStore();
    const one = createClaudeCodeParser(undefined, { lookup: whole });
    whole.apply(one.push(`${text.join("\n")}`));
    const store = new MemoryStore();
    const first = createClaudeCodeParser(undefined, { lookup: store });
    store.apply(first.push(`${text.slice(0, cut).join("\n")}\n`));
    const second = createClaudeCodeParser(JSON.parse(JSON.stringify(first.snapshot())), { lookup: store });
    store.apply(second.push(text.slice(cut).join("\n")));
    expect(normal(store.graph())).toEqual(normal(whole.graph()));
  });
});
