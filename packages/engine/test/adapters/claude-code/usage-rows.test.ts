/** One response logged over several assistant rows of one message id, each with its own usage. */
import type { Call } from "@quantext/shared";
import { describe, expect, test } from "vitest";
import { sha256Sorted } from "../../../src/adapters/claude-code/hash.ts";
import { parseClaudeCodeSession } from "../../../src/adapters/claude-code/index.ts";
import type { Json } from "../../../src/adapters/claude-code/json.ts";

const S = "00000000-0000-4000-8000-00000000cafe";
const shape = { system: [{ type: "text", text: "You are a test agent." }], tools: [] };
const shapeHash = sha256Sorted(shape as unknown as Json);
const prompt: Json[] = [{ type: "text", text: "Go." }];
const line = (row: object) => `${JSON.stringify(row)}\n`;
const head =
  line({ type: "api-request-shape", sessionId: S, shapeHash, shape }) +
  line({ type: "user", sessionId: S, message: { role: "user", content: prompt } }) +
  line({
    type: "api-request",
    sessionId: S,
    id: "c0",
    shapeHash,
    params: { model: "claude-opus-5-5" },
    keep: 0,
    tail: [sha256Sorted({ role: "user", content: prompt })],
    cacheControl: [],
  });

interface RawUsage {
  input: number;
  read: number;
  write: number;
  w5m: number;
  output: number;
}
const row = (text: string, u: RawUsage) =>
  line({
    type: "assistant",
    sessionId: S,
    requestRef: "c0",
    message: {
      id: "msg_a",
      role: "assistant",
      model: "claude-opus-5-5",
      content: [{ type: "text", text }],
      usage: {
        input_tokens: u.input,
        cache_read_input_tokens: u.read,
        cache_creation_input_tokens: u.write,
        cache_creation: { ephemeral_5m_input_tokens: u.w5m, ephemeral_1h_input_tokens: 0 },
        output_tokens: u.output,
      },
    },
  });

const callOf = (text: string): Call | undefined => parseClaudeCodeSession({ main: text, subagents: [] }).calls[0];
const first: RawUsage = { input: 12, read: 0, write: 3000, w5m: 3000, output: 4 };

describe("usage over the rows of one response", () => {
  test("keeps the first non-zero input side when a later row reports input 0 (but a 5m cache write)", () => {
    const call = callOf(head + row("a", first) + row("b", { input: 0, read: 0, write: 0, w5m: 3000, output: 40 }));
    expect(call?.usage).toMatchObject({
      inputTokens: 12,
      cacheReadTokens: 0,
      cacheWriteTokens: 3000,
      cacheWrite5mTokens: 3000,
    });
    expect(call?.usage?.outputTokens).toBe(40);
    expect(call?.issues).toEqual([]);
    expect(call?.cost?.totalUsd).toBeGreaterThan(0);
  });

  test("takes the input side of a later row when the first row had none", () => {
    const call = callOf(
      head + row("a", { input: 0, read: 0, write: 0, w5m: 0, output: 1 }) + row("b", { ...first, output: 9 }),
    );
    expect(call?.usage).toMatchObject({ inputTokens: 12, cacheWriteTokens: 3000, outputTokens: 9 });
  });

  test("a change of the output only is no reconciliation issue", () => {
    const call = callOf(
      head + row("a", first) + row("b", { ...first, output: 50 }) + row("c", { ...first, output: 80 }),
    );
    expect(call?.usage?.outputTokens).toBe(80);
    expect(call?.issues).toEqual([]);
  });

  test("a later copy of the message with output 0 does not drop the output", () => {
    const done = callOf(head + row("a", first) + row("b", { ...first, output: 600 }));
    const call = callOf(
      head + row("a", first) + row("b", { ...first, output: 600 }) + row("b", { ...first, output: 0 }),
    );
    expect(call?.usage?.outputTokens).toBe(600);
    expect(call?.cost?.totalUsd).toBe(done?.cost?.totalUsd);
  });

  test("a different non-zero input side after the split is still flagged", () => {
    const call = callOf(head + row("a", first) + row("b", { ...first, input: 500 }));
    expect(call?.issues.map((i) => i.kind)).toEqual(["unreconciled-tokens"]);
    expect(call?.usage?.inputTokens).toBe(12);
  });
});
