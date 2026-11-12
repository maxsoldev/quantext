import { describe, expect, test } from "vitest";
import { sha256Sorted } from "../../../src/adapters/claude-code/hash.ts";
import { createClaudeCodeParser, parseClaudeCodeSession } from "../../../src/adapters/claude-code/index.ts";
import type { Json } from "../../../src/adapters/claude-code/json.ts";
import { MemoryStore } from "./memory-store.ts";

const S = "00000000-0000-4000-8000-00000000f00d";
const shape = { system: [{ type: "text", text: "You are a test agent." }], tools: [] };
const shapeHash = sha256Sorted(shape as unknown as Json);
const wire = (role: string, content: Json[]) => sha256Sorted({ role, content });
const line = (row: object) => `${JSON.stringify(row)}\n`;
const request = (id: string, tail: string[]) =>
  line({
    type: "api-request",
    sessionId: S,
    id,
    shapeHash,
    params: { model: "claude-opus-5-5" },
    keep: 0,
    tail,
    cacheControl: [],
  });
const usage = { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1 };
const assistant = (ref: string, id: string, content: Json[]) =>
  line({ type: "assistant", sessionId: S, requestRef: ref, message: { id, role: "assistant", content, usage } });

describe("the parser's frontier", () => {
  test("a call dropped from the waiting list says why", () => {
    const rows = Array.from({ length: 33 }, (_, i) => request(`c${i}`, [`missing-${i}`])).join("");
    const graph = parseClaudeCodeSession({ main: rows, subagents: [] });
    expect(graph.calls[0]?.issues.map((i) => i.detail)).toContain("stopped waiting after 32 newer incomplete calls");
    expect(graph.calls[1]?.issues.map((i) => i.detail)).not.toContain(
      "stopped waiting after 32 newer incomplete calls",
    );
  });

  test("rows of an older assistant message that is still open resolve after a restore", () => {
    const a1: Json = { type: "text", text: "First part." };
    const a2: Json = { type: "text", text: "Second part." };
    const prompt: Json[] = [{ type: "text", text: "Go." }];
    const store = new MemoryStore();
    const first = createClaudeCodeParser(undefined, { lookup: store });
    store.apply(first.push(line({ type: "api-request-shape", sessionId: S, shapeHash, shape })));
    store.apply(first.push(line({ type: "user", sessionId: S, message: { role: "user", content: prompt } })));
    store.apply(first.push(request("c0", [wire("user", prompt)])));
    store.apply(first.push(assistant("c0", "msg_a", [a1])));
    store.apply(first.push(assistant("side", "msg_b", [{ type: "text", text: "Other." }])));
    const second = createClaudeCodeParser(JSON.parse(JSON.stringify(first.snapshot())), { lookup: store });
    store.apply(second.push(assistant("c0", "msg_a", [a2])));
    store.apply(second.push(request("c1", [wire("user", prompt), wire("assistant", [a1, a2])])));
    const call = store.graph().calls.find((c) => c.id === "c1");
    expect(call?.issues.filter((i) => i.kind === "unresolved-request")).toEqual([]);
  });

  test("a long run of user rows does not grow the snapshot", () => {
    const parser = createClaudeCodeParser();
    const rows = Array.from({ length: 5000 }, (_, i) =>
      line({ type: "user", sessionId: S, message: { role: "user", content: [{ type: "text", text: `note ${i}` }] } }),
    ).join("");
    parser.push(rows);
    expect(JSON.stringify(parser.snapshot()).length).toBeLessThan(20_000);
  });

  test("a request ends the run of user rows: later rows start a new one", () => {
    const parser = createClaudeCodeParser();
    const user = (text: string) =>
      line({ type: "user", sessionId: S, message: { role: "user", content: [{ type: "text", text }] } });
    parser.push(user("one") + user("two") + request("c0", ["x"]) + user("three"));
    expect(parser.snapshot().transcripts.main?.userRun).toHaveLength(1);
  });
});

describe("a message missing from the log", () => {
  const prompt: Json[] = [{ type: "text", text: "Go." }];
  const shapeRow = line({ type: "api-request-shape", sessionId: S, shapeHash, shape });
  const user = line({ type: "user", sessionId: S, message: { role: "user", content: prompt } });
  const step = (i: number, keep: number, tail: string[]) =>
    line({
      type: "api-request",
      sessionId: S,
      id: `c${i}`,
      shapeHash,
      params: { model: "claude-opus-5-5" },
      ...(i === 0 ? {} : { base: `c${i - 1}` }),
      keep,
      tail,
      cacheControl: [],
    }) +
    line({
      type: "assistant",
      sessionId: S,
      requestRef: `c${i}`,
      message: {
        id: `msg_${i}`,
        role: "assistant",
        content: [{ type: "text", text: `Reply ${i}.` }],
        usage: {
          input_tokens: 100 + 40 * i,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
          output_tokens: 3,
        },
      },
    });

  test("does not make the rest of the lane unresolved: one gap, one flagged Call", () => {
    let rows = shapeRow + user + step(0, 0, [wire("user", prompt)]) + step(1, 1, ["not-in-the-log"]);
    let keep = 2;
    for (let i = 2; i < 40; i++) {
      rows += step(i, keep, [wire("assistant", [{ type: "text", text: `Reply ${i - 1}.` }])]);
      keep++;
    }
    const graph = parseClaudeCodeSession({ main: rows, subagents: [] });
    expect(graph.calls).toHaveLength(40);
    expect(graph.calls.flatMap((c) => c.issues.map((i) => `${c.id} ${i.kind}`))).toEqual(["c1 missing-message"]);
    expect(graph.calls.every((c) => c.blockCount !== undefined)).toBe(true);
    expect(graph.blocks.filter((b) => b.kind === "gap")).toHaveLength(1);
    const store = new MemoryStore();
    let parser = createClaudeCodeParser(undefined, { lookup: store });
    for (const row of rows.split("\n").filter((l) => l !== "")) {
      store.apply(parser.push(`${row}\n`));
      parser = createClaudeCodeParser(JSON.parse(JSON.stringify(parser.snapshot())), { lookup: store });
    }
    const restored = store.graph();
    expect(restored.calls.flatMap((c) => c.issues.map((i) => `${c.id} ${i.kind}`))).toEqual(["c1 missing-message"]);
    expect(restored.callBlocks.length).toBe(graph.callBlocks.length);
  });
});
