import type { Usage } from "@quantext/shared";
import { describe, expect, test } from "vitest";
import type { CallAttributionInput, Share } from "../../src/core/attribute.ts";
import { attributeCall, cachedPrefixLength } from "../../src/core/attribute.ts";

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

const est = (tokens: number) => ({ estimate: { tokens, method: "chars" as const } });
const carried = (share: Share) => ({ ...est(1), carried: share });
const nothingKept = { count: 0, tokens: 0, exact: true, estimates: () => [] };
const kept = (tokens: number[], exact = true) => ({
  count: tokens.length,
  tokens: tokens.reduce((a, b) => a + b, 0),
  exact,
  estimates: () => tokens.map((t) => ({ tokens: t, method: "chars" as const })),
});

function run(input: Partial<CallAttributionInput> & Pick<CallAttributionInput, "usage" | "fresh">) {
  return attributeCall({ id: "c", kept: nothingKept, ...input });
}

describe("attributeCall", () => {
  test("splits a first call's total over its blocks by estimate, as one group that adds up exactly", () => {
    const result = run({ usage: usage(100), fresh: [est(30), est(10)] });
    expect(result.fresh).toEqual([
      { tokens: 75, basis: "estimate", group: "c#0" },
      { tokens: 25, basis: "estimate", group: "c#0" },
    ]);
    expect(result).toMatchObject({ framingTokens: 0, issues: [], groups: [{ id: "c#0", size: 2 }] });
  });

  test("gives one new block after an exact kept prefix the exact rest", () => {
    const result = run({ usage: usage(140), kept: kept([75, 25]), fresh: [est(99)] });
    expect(result.fresh).toEqual([{ tokens: 40, basis: "exact" }]);
    expect(result.groups).toEqual([]);
  });

  test("splits the exact rest over several new blocks by estimate, as a new group", () => {
    const result = run({ usage: usage(131), kept: kept([100]), fresh: [est(1), est(2)] });
    expect(result.fresh).toEqual([
      { tokens: 10, basis: "estimate", group: "c#0" },
      { tokens: 21, basis: "estimate", group: "c#0" },
    ]);
  });

  test("does not call the rest exact when the kept prefix holds part of a group", () => {
    // A = [x, y] (one group, 100), B = [x, z]: y was dropped, so x alone is only an estimate.
    const result = run({ usage: usage(90), kept: kept([75], false), fresh: [est(10)] });
    expect(result.fresh).toEqual([{ tokens: 15, basis: "estimate" }]);
    expect(result.groups).toEqual([]);
  });

  test("does not call the rest exact when a block carried by content is an estimate", () => {
    // A = [x, y] (one group, 100), B = [y, z]: y is found again by content, but its 25 are an estimate.
    const result = run({
      usage: usage(90),
      fresh: [carried({ tokens: 25, basis: "estimate", group: "a#0" }), est(10)],
    });
    expect(result.fresh).toEqual([
      { tokens: 25, basis: "estimate", group: "a#0" },
      { tokens: 65, basis: "estimate" },
    ]);
  });

  test("a whole group carried by content keeps the rest exact", () => {
    const g = { basis: "estimate" as const, group: "a#0" };
    const result = run({
      usage: usage(90),
      fresh: [carried({ tokens: 25, ...g }), carried({ tokens: 35, ...g }), est(10)],
      groupSize: (group) => (group === "a#0" ? 2 : 0),
    });
    expect(result.fresh[2]).toEqual({ tokens: 30, basis: "exact" });
  });

  test("a block carried by content with an exact count keeps the rest exact", () => {
    const result = run({ usage: usage(90), fresh: [carried({ tokens: 25, basis: "exact" }), est(10)] });
    expect(result.fresh[1]).toEqual({ tokens: 65, basis: "exact" });
  });

  test("counts the input after the last block as framing, when the last block carries the last breakpoint", () => {
    const result = run({
      usage: usage(142, { read: 98, write: 40 }),
      kept: kept([49, 49]),
      fresh: [est(5)],
      lastBreakpoint: 2,
    });
    expect(result.framingTokens).toBe(4);
    expect(result.fresh).toEqual([{ tokens: 40, basis: "exact" }]);
  });

  test("splits at a breakpoint before the last block: the cache covers up to it, plain input after it", () => {
    const input = { usage: usage(150, { write: 120 }), fresh: [est(10), est(10), est(10)], lastBreakpoint: 1 };
    expect(run(input).fresh).toEqual([
      { tokens: 60, basis: "estimate", group: "c#0" },
      { tokens: 60, basis: "estimate", group: "c#0" },
      { tokens: 30, basis: "exact" },
    ]);
  });

  test("never takes a cache read as a split: it may end anywhere", () => {
    const result = run({
      usage: usage(200, { read: 110, write: 88 }),
      fresh: [est(40), est(60), est(100)],
      lastBreakpoint: 2,
    });
    expect(result.fresh.map((s) => [s.tokens, s.basis])).toEqual([
      [40, "estimate"],
      [59, "estimate"],
      [99, "estimate"],
    ]);
  });

  test("flags a call whose kept blocks exceed its total, and splits the whole total by estimate", () => {
    const result = run({ usage: usage(90), kept: kept([50, 50]), fresh: [est(20)] });
    expect(result.issues).toEqual([
      { kind: "unreconciled-tokens", detail: "blocks kept from the previous call have 100 tokens, more than 90" },
    ]);
    expect(result.kept?.map((s) => s.tokens)).toEqual([38, 37]);
    expect(result.fresh.map((s) => s.tokens)).toEqual([15]);
  });

  test("flags a call whose total changed with no new block", () => {
    const result = run({ usage: usage(103), kept: kept([100]), fresh: [] });
    expect(result.issues).toEqual([
      { kind: "unreconciled-tokens", detail: "3 tokens more than the previous call, but no new block" },
    ]);
    expect(result.kept).toEqual([{ tokens: 103, basis: "exact" }]);
  });

  test("gives a block with an unknown estimate what the known estimates leave", () => {
    const unknown = { estimate: { tokens: 0, method: "unknown" as const } };
    expect(run({ usage: usage(100), fresh: [est(30), unknown] }).fresh.map((s) => s.tokens)).toEqual([30, 70]);
  });

  test("gives blocks marked as the rest what the known weights leave, in proportion", () => {
    const rest = (tokens: number) => ({ estimate: { tokens, method: "rest" as const } });
    expect(run({ usage: usage(105), fresh: [est(86), rest(10), rest(30)] }).fresh.map((s) => s.tokens)).toEqual([
      86, 5, 14,
    ]);
    expect(run({ usage: usage(50), fresh: [est(86), rest(10)] }).fresh.map((s) => s.tokens)).toEqual([50, 0]);
  });

  test("marks the one other block after the previous reply as anchored: the exact change less the reply's output", () => {
    const output = (tokens: number) => ({ estimate: { tokens, method: "output" as const } });
    const rest = (tokens: number) => ({ estimate: { tokens, method: "rest" as const } });
    const result = run({ usage: usage(205), kept: kept([100]), fresh: [output(86), rest(22)] });
    expect(result.fresh).toEqual([
      { tokens: 86, basis: "estimate", group: "c#0" },
      { tokens: 19, basis: "anchored", group: "c#0" },
    ]);
    expect(result.issues).toEqual([]);
  });

  test("raises a block below its lower bound to the bound, takes the excess from the reply, and says so", () => {
    const output = { estimate: { tokens: 112, method: "output" as const } };
    const result = attributeCall({
      id: "c",
      usage: usage(216),
      kept: kept([100]),
      fresh: [output, { estimate: { tokens: 10, method: "rest" as const, min: 15 } }],
    });
    expect(result.fresh.map((s) => [s.tokens, s.basis])).toEqual([
      [101, "estimate"],
      [15, "anchored"],
    ]);
    expect(result.issues).toEqual([
      { kind: "estimate-clamped", detail: "1 block raised to its lower bound (15 tokens instead of 4)" },
    ]);
  });

  test("marks the single block of a derived total as derived", () => {
    const derived = { ...usage(100), basis: "derived" as const };
    expect(run({ usage: derived, fresh: [est(30)] }).fresh).toEqual([{ tokens: 100, basis: "derived" }]);
  });
});

describe("cachedPrefixLength", () => {
  const prefix = [0, 50, 100, 140];
  const at = (i: number) => prefix[i] ?? 0;

  test("counts the blocks that end inside the cache read", () => {
    expect(cachedPrefixLength(at, 3, 100)).toBe(2);
    expect(cachedPrefixLength(at, 3, 140)).toBe(3);
  });

  test("does not round a block that the cache read ends inside into the cached prefix", () => {
    expect(cachedPrefixLength(at, 3, 96)).toBe(1);
    expect(cachedPrefixLength(at, 3, 0)).toBe(0);
  });
});
