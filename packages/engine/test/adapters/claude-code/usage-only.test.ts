/** Sessions of harness versions that log no requests (no `api-request` rows, no `requestRef`): usage only. */
import { describe, expect, test } from "vitest";
import { parseClaudeCodeSession } from "../../../src/adapters/claude-code/index.ts";
import { transcriptsOf } from "../../fixtures.ts";

const S = "00000000-0000-4000-8000-0000000001d0";
const line = (row: object) => `${JSON.stringify(row)}\n`;
const usage = (input: number, output: number) => ({
  input_tokens: input,
  cache_read_input_tokens: 1000,
  cache_creation_input_tokens: 200,
  cache_creation: { ephemeral_5m_input_tokens: 200, ephemeral_1h_input_tokens: 0 },
  output_tokens: output,
});
const reply = (id: string, ts: string, content: object[], u: object, model = "claude-opus-5-5") =>
  line({
    type: "assistant",
    sessionId: S,
    timestamp: ts,
    version: "2.1.284",
    message: { id, role: "assistant", model, content, usage: u },
  });
const oldFormat =
  line({
    type: "user",
    sessionId: S,
    timestamp: "2026-01-01T00:00:00.000Z",
    message: { role: "user", content: "Go." },
  }) +
  reply("msg_1", "2026-01-01T00:00:01.000Z", [{ type: "text", text: "Reading." }], usage(10, 5)) +
  reply(
    "msg_1",
    "2026-01-01T00:00:02.000Z",
    [{ type: "tool_use", id: "toolu_1", name: "Read", input: {} }],
    usage(10, 30),
  ) +
  line({
    type: "user",
    sessionId: S,
    timestamp: "2026-01-01T00:00:03.000Z",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "file" }] },
  }) +
  reply("msg_2", "2026-01-01T00:00:04.000Z", [{ type: "text", text: "Done." }], usage(20, 7)) +
  reply("msg_x", "2026-01-01T00:00:05.000Z", [{ type: "text", text: "API error" }], usage(0, 0), "<synthetic>");

describe("a session whose harness logs no requests", () => {
  const graph = parseClaudeCodeSession({ main: oldFormat, subagents: [] });

  test("has one usage-only Call per response, with exact usage and cost, and no Blocks", () => {
    expect(graph.calls.map((c) => [c.id, c.index, c.model, c.ts, c.usage?.outputTokens])).toEqual([
      ["msg_1", 0, "claude-opus-5-5", "2026-01-01T00:00:01.000Z", 30],
      ["msg_2", 1, "claude-opus-5-5", "2026-01-01T00:00:04.000Z", 7],
    ]);
    for (const call of graph.calls) {
      expect(call.usage?.basis).toBe("exact");
      expect(call.cost?.totalUsd).toBeGreaterThan(0);
      expect(call.blockCount).toBeUndefined();
      expect(call.issues.map((i) => i.kind)).toEqual(["no-request"]);
    }
    expect(graph.callBlocks).toEqual([]);
  });

  test("links its tool calls to the usage-only Call of their response", () => {
    expect(graph.toolCalls.map((t) => [t.id, t.callId, t.durationMs])).toEqual([["toolu_1", "msg_1", 1000]]);
  });

  test("says that its request log is absent", () => {
    expect(graph.sessions.map((s) => s.requestLog)).toEqual(["absent"]);
  });

  test("is partial when it goes on under a harness version that logs requests", () => {
    const { main } = transcriptsOf("basic-tools");
    const moved = oldFormat.replaceAll(S, "00000000-0000-4000-8000-000000000001");
    const mixed = parseClaudeCodeSession({ main: moved + main, subagents: [] });
    expect(mixed.sessions.map((s) => s.requestLog)).toEqual(["partial"]);
  });

  test("is present for a harness that logs every request", () => {
    expect(parseClaudeCodeSession(transcriptsOf("basic-tools")).sessions.map((s) => s.requestLog)).toEqual(["present"]);
  });
});
