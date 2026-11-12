import type { CallContext, ContextBlock, ContextDiff } from "@quantext/shared";
import { describe, expect, test } from "vitest";
import { diffView } from "./model.ts";

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
