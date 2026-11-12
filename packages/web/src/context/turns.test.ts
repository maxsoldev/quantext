import type { CallContext, ContextBlock, ContextTurn } from "@quantext/shared";
import { describe, expect, test } from "vitest";
import {
  collapseAll,
  DEFAULT_COLLAPSE,
  expandAll,
  readCollapse,
  revealBlock,
  toggleEarlier,
  toggleTurn,
} from "./collapse.ts";
import type { Row } from "./model.ts";
import { listRows, turnKey } from "./model.ts";

const block = (position: number, turn: number | undefined, extra: Partial<ContextBlock> = {}) =>
  ({
    position,
    section: turn === undefined ? "system" : "messages",
    hash: `h${position}`,
    kind: "assistant",
    category: "assistant",
    source: {},
    tokens: 10,
    basis: "exact",
    inCachedPrefix: position < 5,
    preview: `text ${position}`,
    chars: 6,
    truncated: false,
    ...(turn === undefined ? {} : { turn }),
    ...extra,
  }) as ContextBlock;
const prompt = (position: number, turn: number, preview: string) =>
  block(position, turn, { kind: "user", category: "user", preview });
// Turn 1: 1–2, turn 2: 3–5, turn 3 (the call's own): 6–7.
const blocks = [
  block(0, undefined),
  prompt(1, 1, "first ask"),
  block(2, 1),
  prompt(3, 2, "second ask"),
  block(4, 2),
  block(5, 2, { preview: "needle here" }),
  prompt(6, 3, "third ask"),
  block(7, 3),
];
const turn = (n: number, start: number, count: number, cached: number): ContextTurn => ({
  turn: n,
  start,
  blocks: count,
  tokens: 10 * count,
  cachedTokens: cached,
  prompt: { position: start, preview: blocks[start]?.preview ?? "" },
});
const ctx = {
  blocks,
  sections: { tools: 0, system: 10, messages: 70, framing: 0 },
  partTotals: [],
  turns: [turn(1, 1, 2, 20), turn(2, 3, 3, 20), turn(3, 6, 2, 0)],
  totalTokens: 80,
} as unknown as CallContext;

/** The messages' rows in short: `E` the earlier turns, `T<n>` a turn, a number a block. */
const shape = (rows: Row[]) =>
  rows.flatMap((r): (string | number)[] => {
    if (r.type === "earlier") return [`E${r.open ? "+" : ""} ${r.turns}/${r.blocks}/${r.tokens}/${r.cached}`];
    if (r.type === "turn") return [`T${r.turn.turn}${r.current ? "*" : r.open ? "+" : ""}`];
    if (r.type === "block" && r.block.section === "messages") return [r.block.position];
    return [];
  });

describe("turns in the messages", () => {
  test("by default the call's own turn is open and the earlier turns are one closed row that sums them", () => {
    expect(shape(listRows(ctx, "", DEFAULT_COLLAPSE))).toEqual(["E 2/5/50/40", "T3*", 6, 7]);
  });

  test("the earlier row opens into a row per turn; a turn opens into its blocks", () => {
    const earlier = toggleEarlier(DEFAULT_COLLAPSE);
    expect(shape(listRows(ctx, "", earlier))).toEqual(["E+ 2/5/50/40", "T1", "T2", "T3*", 6, 7]);
    const second = toggleTurn(earlier, turnKey(ctx, ctx.turns[1] as ContextTurn));
    expect(shape(listRows(ctx, "", second))).toEqual(["E+ 2/5/50/40", "T1", "T2+", 3, 4, 5, "T3*", 6, 7]);
    expect(shape(listRows(ctx, "", toggleTurn(second, turnKey(ctx, ctx.turns[1] as ContextTurn))))).toEqual(
      shape(listRows(ctx, "", earlier)),
    );
  });

  test("a turn's key is its prompt's hash, so it stays open on the next call", () => {
    expect(turnKey(ctx, ctx.turns[1] as ContextTurn)).toBe("h3");
  });

  test("a search opens the earlier turn it finds in, with only what matches", () => {
    expect(shape(listRows(ctx, "needle", DEFAULT_COLLAPSE))).toEqual(["E+ 2/5/50/40", "T2+", 5]);
  });

  test("only new keeps the blocks added since the previous call, and opens the turns they are in", () => {
    expect(shape(listRows(ctx, "", DEFAULT_COLLAPSE, new Set([4, 7])))).toEqual(["E+ 2/5/50/40", "T2+", 4, "T3*", 7]);
    expect(shape(listRows(ctx, "", DEFAULT_COLLAPSE, new Set([7])))).toEqual(["T3*", 7]);
  });

  test("one turn only has no turn rows", () => {
    const one = { ...ctx, turns: [{ ...turn(1, 1, 7, 40), tokens: 70 }] } as CallContext;
    expect(shape(listRows(one, "", DEFAULT_COLLAPSE))).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  test("a link to a block in an earlier turn opens that turn; expand all opens all, collapse all closes", () => {
    const linked = revealBlock(collapseAll(), blocks[4] as ContextBlock, ctx);
    expect(shape(listRows(ctx, "", linked))).toEqual(["E+ 2/5/50/40", "T1", "T2+", 3, 4, 5, "T3*", 6, 7]);
    expect(shape(listRows(ctx, "", expandAll(collapseAll(), ctx)))).toEqual([
      "E+ 2/5/50/40",
      "T1+",
      1,
      2,
      "T2+",
      3,
      4,
      5,
      "T3*",
      6,
      7,
    ]);
    expect(collapseAll()).toMatchObject({ earlier: false, turns: [] });
  });

  test("the open turns are stored, and the earlier turns are closed when nothing is stored", () => {
    const s = toggleTurn(toggleEarlier(DEFAULT_COLLAPSE), "h3");
    expect(readCollapse(JSON.stringify(s))).toMatchObject({ earlier: true, turns: ["h3"] });
    expect(readCollapse(null)).toMatchObject({ earlier: false, turns: [] });
    expect(readCollapse('{"earlier":"yes","turns":[1,"h1"]}')).toMatchObject({ earlier: false, turns: ["h1"] });
  });
});
