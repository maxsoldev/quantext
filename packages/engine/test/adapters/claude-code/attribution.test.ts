import { describe, expect, test } from "vitest";
import { parseClaudeCodeSession } from "../../../src/adapters/claude-code/index.ts";
import { scenarios, transcriptsOf } from "../../fixtures.ts";
import { blocksAt, inCachedPrefix, inputTotal, runsAt, tokensOf } from "./helpers.ts";

describe.each(scenarios())("attribution of $version/$name", ({ name }) => {
  const graph = parseClaudeCodeSession(transcriptsOf(name));
  const logged = graph.calls.filter((call) => call.usage?.basis === "exact");

  test.each(logged.map((call) => [call.index, call] as const))(
    "call %i: its blocks and framing add up to the exact input total",
    (_, call) => {
      expect(call.issues).toEqual([]);
      const runs = runsAt(graph, call);
      expect(runs.every((r) => r.basis !== undefined && Number.isInteger(r.tokens))).toBe(true);
      expect(tokensOf(runs) + call.framingTokens).toBe(inputTotal(call));
    },
  );
});

describe("exact parts of the attribution", () => {
  test("the new blocks of a call hold exactly the change of its cached total", () => {
    const graph = parseClaudeCodeSession(transcriptsOf("basic-tools"));
    const [first, second] = [runsAt(graph, graph.calls[0]), runsAt(graph, graph.calls[1])];
    // Call 1: read 16 557 + write 105, after call 0's read 0 + write 16 557.
    expect(tokensOf(second.filter((r) => r.firstCall === 1))).toBe(105);
    expect(second.slice(0, first.length).map((r) => r.tokens)).toEqual(first.map((r) => r.tokens));
  });

  test("the blocks kept from the call before are the cached prefix", () => {
    const graph = parseClaudeCodeSession(transcriptsOf("basic-tools"));
    const call = graph.calls[1];
    const firstCount = runsAt(graph, graph.calls[0]).length;
    expect(runsAt(graph, call).map((r) => inCachedPrefix(r, call))).toEqual(
      runsAt(graph, call).map((r) => r.position < firstCount),
    );
  });

  test("a block that the cache read ends inside is not in the cached prefix", () => {
    // compaction call 4 read 12 698 tokens: more than the tool schemas and system prompt, less than the summary after.
    const graph = parseClaudeCodeSession(transcriptsOf("compaction"));
    const call = graph.calls[4];
    const byHash = new Map(graph.blocks.map((b) => [b.hash, b]));
    const summary = runsAt(graph, call).find((r) => byHash.get(r.blockHash)?.kind === "summary");
    expect(summary !== undefined && inCachedPrefix(summary, call)).toBe(false);
    const before = runsAt(graph, call).filter((r) => summary !== undefined && r.position < summary.position);
    expect(tokensOf(before)).toBeLessThanOrEqual(12698);
  });

  test("the request after a model change starts a fresh split", () => {
    const graph = parseClaudeCodeSession(transcriptsOf("effort"));
    const call = graph.calls[2];
    expect(call?.canonicalModel).toBe("claude-sonnet-4-5");
    expect(runsAt(graph, call).every((r) => r.basis === "estimate" && !inCachedPrefix(r, call))).toBe(true);
  });

  test("a deferred tool schema nobody loads is not part of the input", () => {
    const graph = parseClaudeCodeSession(transcriptsOf("mcp-deferred"));
    expect(blocksAt(graph, graph.calls[0]).filter((b) => b.source.tool === "DeferredToolPlaceholder")).toEqual([]);
  });

  test("a loaded deferred schema is part of the call's cache write, not of its cache read", () => {
    const graph = parseClaudeCodeSession(transcriptsOf("mcp-deferred"));
    const call = graph.calls[1];
    const runs = runsAt(graph, call);
    const byHash = new Map(graph.blocks.map((b) => [b.hash, b]));
    const schema = runs.find((r) => byHash.get(r.blockHash)?.source.tool === "mcp__dictionary__lookup_word");
    expect(schema && inCachedPrefix(schema, call)).toBe(false);
    const end = tokensOf(runs.filter((r) => schema !== undefined && r.position <= schema.position));
    expect(end).toBeGreaterThan(call?.usage?.cacheReadTokens ?? 0);
    expect(end).toBeLessThanOrEqual((call?.usage?.cacheReadTokens ?? 0) + (call?.usage?.cacheWriteTokens ?? 0));
  });

  test("the previous response gets its output tokens as weight, the tool result the rest", () => {
    // basic-tools call 1: the Bash tool use came back with 86 output tokens; the change is 105 tokens.
    const graph = parseClaudeCodeSession(transcriptsOf("basic-tools"));
    const byHash = new Map(graph.blocks.map((b) => [b.hash, b]));
    const fresh = runsAt(graph, graph.calls[1]).filter((r) => r.firstCall === 1);
    expect(fresh.map((r) => [byHash.get(r.blockHash)?.kind, r.tokens, r.basis])).toEqual([
      ["tool-call", 86, "estimate"],
      ["tool-result", 19, "estimate"],
    ]);
  });
});
