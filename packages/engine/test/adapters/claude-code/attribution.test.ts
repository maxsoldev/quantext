import type { Call, CallBlock, SessionGraph } from "@quantext/shared";
import { describe, expect, test } from "vitest";
import { parseClaudeCodeSession } from "../../../src/adapters/claude-code/index.ts";
import { scenarios, transcriptsOf } from "../../fixtures.ts";

const inputTotal = (call: Call) =>
  (call.usage?.inputTokens ?? 0) + (call.usage?.cacheReadTokens ?? 0) + (call.usage?.cacheWriteTokens ?? 0);

const own = (graph: SessionGraph, call: Call | undefined): CallBlock[] =>
  graph.callBlocks.filter((cb) => cb.callId === call?.id).sort((a, b) => a.position - b.position);

const sum = (cbs: readonly CallBlock[]) => cbs.reduce((total, cb) => total + (cb.tokens ?? 0), 0);

describe.each(scenarios())("attribution of $version/$name", ({ name }) => {
  const graph = parseClaudeCodeSession(transcriptsOf(name));

  const logged = graph.calls.filter((call) => call.usage?.basis === "exact");
  test.each(logged.map((call) => [call.index, call] as const))(
    "call %i: its blocks and framing add up to the exact input total",
    (_, call) => {
      expect(call.issues).toEqual([]);
      const blocks = own(graph, call);
      expect(blocks.every((cb) => cb.basis !== undefined && Number.isInteger(cb.tokens))).toBe(true);
      expect(sum(blocks) + call.framingTokens).toBe(inputTotal(call));
    },
  );
});

describe("exact parts of the attribution", () => {
  test("the first call's tool schemas and system blocks are exactly its cache read", () => {
    // image call 0 read 10 772 tokens from the cache: the tool schemas and the system prompt, up to system.1.
    const graph = parseClaudeCodeSession(transcriptsOf("image"));
    const first = own(graph, graph.calls[0]);
    expect(sum(first.filter((cb) => cb.section !== "messages"))).toBe(10772);
    expect(graph.calls[0]?.usage?.cacheReadTokens).toBe(10772);
  });

  test("the new blocks of a call hold exactly the change of its cached total", () => {
    const graph = parseClaudeCodeSession(transcriptsOf("basic-tools"));
    const [first, second] = [own(graph, graph.calls[0]), own(graph, graph.calls[1])];
    const known = new Set(first.map((cb) => cb.blockHash));
    // Call 1: read 16 557 + write 105, after call 0's read 0 + write 16 557.
    expect(sum(second.filter((cb) => !known.has(cb.blockHash)))).toBe(105);
    expect(second.slice(0, first.length).map((cb) => cb.tokens)).toEqual(first.map((cb) => cb.tokens));
  });

  test("the blocks kept from the call before are the cached prefix", () => {
    const graph = parseClaudeCodeSession(transcriptsOf("basic-tools"));
    const second = own(graph, graph.calls[1]);
    const firstCount = own(graph, graph.calls[0]).length;
    expect(second.map((cb) => cb.inCachedPrefix)).toEqual(second.map((cb) => cb.position < firstCount));
  });

  test("the request after a model change starts a fresh split", () => {
    const graph = parseClaudeCodeSession(transcriptsOf("effort"));
    const sonnet = own(graph, graph.calls[2]);
    expect(graph.calls[2]?.canonicalModel).toBe("claude-sonnet-4-5");
    expect(sonnet.every((cb) => cb.basis === "estimate" && !cb.inCachedPrefix)).toBe(true);
  });

  test("a deferred tool schema has no tokens until a tool reference loads it", () => {
    const graph = parseClaudeCodeSession(transcriptsOf("mcp-deferred"));
    const byHash = new Map(graph.blocks.map((b) => [b.hash, b]));
    const placeholder = own(graph, graph.calls[0]).find(
      (cb) => byHash.get(cb.blockHash)?.source.tool === "DeferredToolPlaceholder",
    );
    expect(placeholder?.tokens).toBe(0);
  });
});
