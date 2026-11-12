import type { CacheBreak, CallContext, ContextBlock, ContextDiff } from "@quantext/shared";
import { describe, expect, test } from "vitest";
import { breakSummary, diffView } from "./model.ts";

const block = (position: number, tokens: number, hash: string, extra: Partial<ContextBlock> = {}) =>
  ({
    position,
    section: "messages",
    hash,
    kind: "user",
    category: "user",
    source: {},
    tokens,
    basis: "estimate",
    inCachedPrefix: true,
    preview: hash,
    chars: 0,
    truncated: false,
    ...extra,
  }) as ContextBlock;

const ctx = (index: number, blocks: ContextBlock[], cacheRead: number): CallContext =>
  ({
    call: { index, usage: { cacheReadTokens: cacheRead } },
    rebuilt: true,
    blocks,
    totalTokens: blocks.reduce((n, b) => n + (b.tokens ?? 0), 0),
  }) as unknown as CallContext;

const diff = (d: Partial<ContextDiff>): ContextDiff =>
  ({ call: 2, previous: 1, added: [], removed: [], moved: [], uncached: [], cacheReadDrop: 0, ...d }) as ContextDiff;

describe("what changed at a Call, drawn as two strips", () => {
  const before = ctx(1, [block(0, 60, "a"), block(1, 20, "b"), block(2, 20, "c")], 80);
  const after = ctx(
    2,
    [block(0, 60, "a"), block(1, 20, "c", { inCachedPrefix: false }), block(2, 120, "d", { inCachedPrefix: false })],
    60,
  );
  const d = diff({
    added: [after.blocks[2] as ContextBlock],
    removed: [before.blocks[1] as ContextBlock],
    moved: [{ ...(after.blocks[1] as ContextBlock), from: 2 }],
    uncached: [after.blocks[1] as ContextBlock],
    firstChange: 1,
    cacheReadDrop: 20,
  });
  const v = diffView(before, after, d);

  test("each strip marks a block by what happened to it", () => {
    expect(v.before.segments.map((s) => s.status)).toEqual(["kept", "removed", "kept"]);
    expect(v.now.segments.map((s) => s.status)).toEqual(["kept", "moved", "added"]);
  });

  test("both strips share one scale, so their lengths compare (200 tokens is the longer one)", () => {
    expect(v.before.segments.map((s) => [s.left, s.width])).toEqual([
      [0, 30],
      [30, 10],
      [40, 10],
    ]);
    expect(v.now.segments.at(-1)).toMatchObject({ left: 40, width: 60 });
  });

  test("each strip marks where its cached prefix ends, and the current one where it first differs", () => {
    expect(v.before.cachedTo).toBe(40);
    expect(v.now.cachedTo).toBe(30);
    expect(v.now.firstChange).toBe(30);
  });

  test("a kept block that is no longer cached is marked as written again", () => {
    expect(v.now.segments[1]?.rewritten).toBe(true);
    expect(v.now.segments[0]?.rewritten).toBe(false);
  });

  test("totals per kind of change, in blocks and tokens", () => {
    expect(v.totals).toEqual({
      added: { blocks: 1, tokens: 120 },
      removed: { blocks: 1, tokens: 20 },
      moved: { blocks: 1, tokens: 20 },
      uncached: { blocks: 1, tokens: 20 },
    });
  });

  test("the lane's first Call has no strip before it", () => {
    const first = diffView(undefined, before, diff({ added: before.blocks }));
    expect(first.before.segments).toEqual([]);
    expect(first.now.segments.every((s) => s.status === "added")).toBe(true);
  });
});

describe("small blocks next to each other", () => {
  // 1,000 tokens: 1 % is 10 tokens. Five small reminders, a big file, two small user texts, one small tool result.
  const small = (p: number, t: number, category: ContextBlock["category"] = "injected-context") =>
    block(p, t, `h${p}`, { category, kind: category === "user" ? "user" : "reminder" });
  const blocks = [
    small(0, 2),
    small(1, 3),
    small(2, 4),
    small(3, 1),
    small(4, 5),
    small(5, 900, "injected-context"),
    small(6, 3, "user"),
    small(7, 2, "user"),
    small(8, 80, "user"),
  ];
  const one = ctx(1, blocks, 0);
  const v = diffView(one, one, diff({ previous: 0 }));

  test("of the same state and category merge into one segment, with their blocks and tokens", () => {
    expect(v.now.segments.map((s) => [s.blocks.map((b) => b.position), s.tokens])).toEqual([
      [[0, 1, 2, 3, 4], 15],
      [[5], 900],
      [[6, 7], 5],
      [[8], 80],
    ]);
    expect(v.now.segments[0]).toMatchObject({ left: 0, width: 1.5, status: "kept", category: "injected-context" });
    expect(v.now.segments[2]).toMatchObject({ left: 91.5, width: 0.5 });
  });

  test("do not merge across a change of state", () => {
    const d = diff({ previous: 0, added: [blocks[2] as ContextBlock], firstChange: 2 });
    const w = diffView(one, one, d);
    expect(w.now.segments.slice(0, 3).map((s) => [s.status, s.blocks.length])).toEqual([
      ["kept", 2],
      ["added", 1],
      ["kept", 2],
    ]);
    expect(w.now.firstChange).toBe(0.5);
  });
});

describe("the cache breaks of a lane, from one call", () => {
  const b = (index: number, reason: CacheBreak["reason"]) => ({ index, reason }) as CacheBreak;
  const breaks = [b(4, "ttl"), b(9, "compaction"), b(12, "ttl"), b(20, "prefix-change")];

  test("counts by reason, most first, and the breaks before and after the call", () => {
    expect(breakSummary(breaks, 12)).toEqual({
      counts: [
        ["ttl", 2],
        ["compaction", 1],
        ["prefix-change", 1],
      ],
      previous: breaks[1],
      next: breaks[3],
    });
  });

  test("before the first break there is no previous one", () => {
    expect(breakSummary(breaks, 2)).toMatchObject({ previous: undefined, next: breaks[0] });
  });
});
