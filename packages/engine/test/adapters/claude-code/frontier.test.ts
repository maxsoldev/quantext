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
