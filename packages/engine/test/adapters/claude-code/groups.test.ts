import { describe, expect, test } from "vitest";
import { sha256Sorted } from "../../../src/adapters/claude-code/hash.ts";
import { parseClaudeCodeSession } from "../../../src/adapters/claude-code/index.ts";
import type { Json } from "../../../src/adapters/claude-code/json.ts";
import { blocksAt, runsAt } from "./helpers.ts";

const S = "00000000-0000-4000-8000-00000000cafe";
const shape = { system: [{ type: "text", text: "You are a test agent." }], tools: [] };
const shapeHash = sha256Sorted(shape as unknown as Json);
const wire = (role: string, content: Json[]) => sha256Sorted({ role, content });
const prompt: Json[] = [{ type: "text", text: "Read the file." }];
const use: Json[] = [{ type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "/repo/a.txt" } }];
const result: Json[] = [{ type: "tool_result", tool_use_id: "toolu_1", content: "a\n".repeat(100) }];
const next: Json[] = [{ type: "text", text: "And now?" }];

function request(id: string, keep: number, tail: string[], base?: string) {
  const breakpoint = { path: ["messages", keep + tail.length - 1, "content", 0] };
  return {
    type: "api-request",
    sessionId: S,
    id,
    shapeHash,
    params: { model: "claude-opus-5-5" },
    keep,
    tail,
    cacheControl: [breakpoint],
    ...(base ? { base } : {}),
  };
}

function answer(ref: string, id: string, content: Json[], read: number, write: number, output: number) {
  const cache_creation = { ephemeral_5m_input_tokens: write, ephemeral_1h_input_tokens: 0 };
  const usage = {
    input_tokens: 2,
    cache_read_input_tokens: read,
    cache_creation_input_tokens: write,
    cache_creation,
    output_tokens: output,
  };
  return { type: "assistant", sessionId: S, requestRef: ref, message: { id, role: "assistant", content, usage } };
}

/** Call 0 sends the prompt; call 1 adds the tool use and its result; call 2 keeps `keep2` messages and adds a text. */
function session(keep2: number): string {
  const done: Json[] = [{ type: "text", text: "Done." }];
  const tail2 = [wire("user", next)];
  const rows = [
    { type: "api-request-shape", sessionId: S, shapeHash, shape },
    { type: "user", sessionId: S, message: { role: "user", content: prompt } },
    request("c0", 0, [wire("user", prompt)]),
    answer("c0", "m0", use, 0, 1000, 40),
    { type: "user", sessionId: S, message: { role: "user", content: result } },
    request("c1", 1, [wire("assistant", use), wire("user", result)], "c0"),
    answer("c1", "m1", done, 1000, 150, 5),
    { type: "user", sessionId: S, message: { role: "user", content: next } },
    request("c2", keep2, tail2, "c1"),
    answer("c2", "m2", [{ type: "text", text: "Ok." }], 0, 1300, 3),
  ];
  return `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`;
}

describe("exactness of a call's new blocks", () => {
  const newBlock = (keep2: number) => {
    const graph = parseClaudeCodeSession({ main: session(keep2), subagents: [] });
    const call = graph.calls[2];
    const kinds = blocksAt(graph, call).map((b) => b.kind);
    const runs = runsAt(graph, call);
    return { run: runs[kinds.lastIndexOf("user")], graph };
  };

  test("one new block after a whole kept prefix is exact", () => {
    // Call 2 keeps all three messages (each group whole) and adds one text: 1300 - 1150 = 150 tokens, exact.
    const { run } = newBlock(3);
    expect(run).toMatchObject({ firstCall: 2, tokens: 150, basis: "exact" });
  });

  test("when a tool result is dropped, the new block depends on its group's estimate: not exact, in no group", () => {
    const { run, graph } = newBlock(2);
    expect(graph.calls[2]?.issues).toEqual([]);
    expect(run?.firstCall).toBe(2);
    expect(run?.basis).toBe("estimate");
    expect(run?.group).toBeUndefined();
  });
});
