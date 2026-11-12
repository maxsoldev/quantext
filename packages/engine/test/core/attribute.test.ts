import type { Usage } from "@quantext/shared";
import { describe, expect, test } from "vitest";
import type { AttributionCall } from "../../src/core/attribute.ts";
import { attributeCalls } from "../../src/core/attribute.ts";

/** Usage with everything as plain input, unless cache numbers are given. */
function usage(total: number, cache: { read?: number; write?: number } = {}): Usage {
  const read = cache.read ?? 0;
  const write = cache.write ?? 0;
  return {
    basis: "exact",
    inputTokens: total - read - write,
    cacheReadTokens: read,
    cacheWriteTokens: write,
    outputTokens: 1,
  };
}

function block(hash: string, tokens: number, cacheBreakpoint = false) {
  return { hash, estimate: { tokens, method: "chars" as const }, cacheBreakpoint };
}

function call(
  id: string,
  blocks: AttributionCall["blocks"],
  u: Usage | undefined,
  previousId?: string,
): AttributionCall {
  const c: AttributionCall = { id, model: "m", blocks };
  if (u !== undefined) c.usage = u;
  if (previousId !== undefined) c.previousId = previousId;
  return c;
}

const tokensOf = (result: ReturnType<typeof attributeCalls>, id: string) =>
  result.get(id)?.blocks?.map((b) => [b.tokens, b.basis]);

describe("attributeCalls", () => {
  test("splits a first call's total over its blocks by estimate, reconciled to the exact total", () => {
    const result = attributeCalls([call("a", [block("x", 30), block("y", 10)], usage(100))]);
    expect(tokensOf(result, "a")).toEqual([
      [75, "estimate"],
      [25, "estimate"],
    ]);
    expect(result.get("a")).toMatchObject({ framingTokens: 0, issues: [] });
  });

  test("keeps the tokens of blocks carried from the previous call; one new block takes the exact rest", () => {
    const result = attributeCalls([
      call("a", [block("x", 30), block("y", 10)], usage(100)),
      call("b", [block("x", 30), block("y", 10), block("z", 99)], usage(140), "a"),
    ]);
    expect(tokensOf(result, "b")).toEqual([
      [75, "estimate"],
      [25, "estimate"],
      [40, "exact"],
    ]);
  });

  test("splits the exact rest over several new blocks by estimate, so they add up to it", () => {
    const result = attributeCalls([
      call("a", [block("x", 10)], usage(100)),
      call("b", [block("x", 10), block("y", 1), block("z", 2)], usage(131), "a"),
    ]);
    expect(tokensOf(result, "b")).toEqual([
      [100, "exact"],
      [10, "estimate"],
      [21, "estimate"],
    ]);
  });

  test("carries blocks by content, also when the request changes order or drops blocks", () => {
    const result = attributeCalls([
      call("a", [block("x", 10), block("y", 10), block("z", 10)], usage(90)),
      call("b", [block("z", 10), block("x", 10), block("new", 10)], usage(70), "a"),
    ]);
    expect(tokensOf(result, "b")).toEqual([
      [30, "estimate"],
      [30, "estimate"],
      [10, "exact"],
    ]);
  });

  test("does not carry tokens across a model change: the tokenizer may differ", () => {
    const first = call("a", [block("x", 10)], usage(100));
    const second = { ...call("b", [block("x", 10), block("y", 10)], usage(150), "a"), model: "other" };
    expect(tokensOf(attributeCalls([first, second]), "b")).toEqual([
      [75, "estimate"],
      [75, "estimate"],
    ]);
  });

  test("counts the input after the last block as framing, when the last block carries the last breakpoint", () => {
    // The cache read and write cover the request up to the last breakpoint; the plain input is what follows it.
    const result = attributeCalls([
      call("a", [block("x", 50), block("y", 50, true)], usage(100, { write: 98 })),
      call("b", [block("x", 50), block("y", 50), block("z", 5, true)], usage(142, { read: 98, write: 40 }), "a"),
    ]);
    expect(result.get("a")?.framingTokens).toBe(2);
    expect(tokensOf(result, "b")?.[2]).toEqual([40, "exact"]);
    expect(result.get("b")?.framingTokens).toBe(4);
  });

  test("uses the cache read of a first call as an exact split at a breakpoint near it", () => {
    // Blocks 0-1 end at a breakpoint whose estimate (100) is near the cache read (110).
    const blocks = [block("t", 40), block("s", 60, true), block("m", 100, true)];
    const result = attributeCalls([call("a", blocks, usage(200, { read: 110, write: 88 }))]);
    expect(tokensOf(result, "a")).toEqual([
      [44, "estimate"],
      [66, "estimate"],
      [88, "exact"],
    ]);
  });

  test("does not use a cache read far from every breakpoint as a split", () => {
    const blocks = [block("t", 40), block("s", 60, true), block("m", 100, true)];
    const result = attributeCalls([call("a", blocks, usage(200, { read: 150, write: 48 }))]);
    expect(tokensOf(result, "a")?.map(([tokens]) => tokens)).toEqual([40, 59, 99]);
  });

  test("marks the blocks inside the cache read as the cached prefix", () => {
    const result = attributeCalls([
      call("a", [block("x", 50), block("y", 50, true)], usage(100, { write: 98 })),
      call("b", [block("x", 50), block("y", 50), block("z", 5, true)], usage(142, { read: 96, write: 42 }), "a"),
    ]);
    expect(result.get("b")?.blocks?.map((b) => b.inCachedPrefix)).toEqual([true, true, false]);
  });

  test("flags a call whose carried blocks exceed its total, and splits the whole total by estimate", () => {
    const result = attributeCalls([
      call("a", [block("x", 10), block("y", 10)], usage(100)),
      call("b", [block("x", 10), block("y", 10), block("z", 20)], usage(90), "a"),
    ]);
    expect(result.get("b")?.issues).toEqual([
      { kind: "unreconciled-tokens", detail: "blocks kept from the previous call have 100 tokens, more than 90" },
    ]);
    expect(tokensOf(result, "b")?.map(([tokens]) => tokens)).toEqual([23, 22, 45]);
  });

  test("flags a call whose total changed with no new block", () => {
    const result = attributeCalls([
      call("a", [block("x", 10)], usage(100)),
      call("b", [block("x", 10)], usage(103), "a"),
    ]);
    expect(result.get("b")?.issues).toEqual([
      { kind: "unreconciled-tokens", detail: "3 tokens more than the previous call, but no new block" },
    ]);
    expect(tokensOf(result, "b")).toEqual([[103, "exact"]]);
  });

  test("gives a block with an unknown estimate what the known estimates leave", () => {
    const unknown = { hash: "pdf", estimate: { tokens: 0, method: "unknown" as const }, cacheBreakpoint: false };
    const result = attributeCalls([call("a", [block("x", 30), unknown], usage(100))]);
    expect(tokensOf(result, "a")).toEqual([
      [30, "estimate"],
      [70, "estimate"],
    ]);
  });

  test("leaves a call with no usage unattributed, and flags it", () => {
    const result = attributeCalls([call("a", [block("x", 30)], undefined)]);
    expect(result.get("a")).toEqual({
      framingTokens: 0,
      issues: [{ kind: "no-usage", detail: "the log has no response with usage for this call" }],
    });
  });

  test("marks the single block of a derived total as derived", () => {
    const derived = { ...usage(100), basis: "derived" as const };
    expect(tokensOf(attributeCalls([call("a", [block("x", 30)], derived)]), "a")).toEqual([[100, "derived"]]);
  });
});
