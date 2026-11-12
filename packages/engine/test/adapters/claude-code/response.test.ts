import type { SessionGraph } from "@quantext/shared";
import { describe, expect, test } from "vitest";
import { parseClaudeCodeSession } from "../../../src/adapters/claude-code/index.ts";
import { scenarios, transcriptsOf } from "../../fixtures.ts";
import { blocksAt } from "./helpers.ts";

const parse = (name: string) => parseClaudeCodeSession(transcriptsOf(name));

describe.each(scenarios().map((s) => s.name))("the response of each call in %s", (name) => {
  const graph = parse(name);
  const blocks = new Map(graph.blocks.map((b) => [b.hash, b]));

  test("every call with exact usage has a response, and its Blocks are in the graph", () => {
    const exact = graph.calls.filter((c) => c.usage?.basis === "exact");
    expect(exact.length).toBeGreaterThan(0);
    for (const call of exact) {
      expect(call.response?.blocks.length, call.id).toBeGreaterThan(0);
      for (const b of call.response?.blocks ?? []) expect(blocks.get(b.hash)?.kind, call.id).toBe(b.kind);
    }
  });

  test("the last call of each Session has its answer", () => {
    for (const session of graph.sessions) {
      const last = graph.calls.filter((c) => c.sessionId === session.id && c.usage?.basis === "exact").at(-1);
      expect(last?.response?.stopReason, session.id).toBeDefined();
    }
  });
});

describe("the response of a call in basic-tools", () => {
  const graph = parse("basic-tools");

  test("holds every row of the assistant message, in order: reasoning, text and tool use", () => {
    const withThinking = graph.calls.find((c) => c.response?.blocks[0]?.kind === "reasoning");
    expect(withThinking?.response).toMatchObject({
      stopReason: "tool_use",
      blocks: [{ kind: "reasoning", reasoning: "omitted" }, { kind: "assistant" }, { kind: "tool-call" }],
    });
    const toolUse = withThinking?.response?.blocks[2];
    const toolCall = graph.toolCalls.find((t) => t.id === toolUse?.toolUseId);
    expect(toolCall?.callId).toBe(withThinking?.id);
  });

  test("names the same Blocks the next call of the lane sends back", () => {
    const [first, second] = graph.calls.filter((c) => c.lane === graph.calls[0]?.lane);
    const sent = new Set(blocksAt(graph, second).map((b) => b.hash));
    for (const b of first?.response?.blocks ?? []) expect(sent.has(b.hash)).toBe(true);
  });
});

test("reasoning the log holds in full is marked full", () => {
  const graph: SessionGraph = parse("effort");
  const reasoning = graph.calls.flatMap((c) => c.response?.blocks ?? []).filter((b) => b.kind === "reasoning");
  expect(reasoning.map((b) => b.reasoning)).toEqual(["full"]);
});
