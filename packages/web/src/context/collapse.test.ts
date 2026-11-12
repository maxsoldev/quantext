import type { CallContext, CallResponseDetail, ContextBlock, ResponseEntry } from "@quantext/shared";
import { describe, expect, test } from "vitest";
import {
  collapseAll,
  DEFAULT_COLLAPSE,
  expandAll,
  readCollapse,
  revealBlock,
  toggleBlock,
  toggleCategory,
  toggleSection,
} from "./collapse.ts";
import type { Row } from "./model.ts";
import { listRows, outputRows } from "./model.ts";

const part = (label: string) => ({
  label,
  source: { attachment: label },
  start: 0,
  end: 1,
  tokens: 5,
  basis: "estimate" as const,
  preview: label,
  chars: 1,
  truncated: false,
});
const block = (position: number, section: ContextBlock["section"], extra: Partial<ContextBlock> = {}) =>
  ({
    position,
    section,
    hash: `h${position}`,
    kind: section === "tools" ? "tool-schema" : "user",
    category: section === "tools" ? "tool-definitions" : "user",
    source: {},
    tokens: 10,
    basis: "exact",
    inCachedPrefix: position < 2,
    costUsd: 0.01,
    preview: "",
    chars: 0,
    truncated: false,
    ...extra,
  }) as ContextBlock;
const merged = block(3, "messages", {
  kind: "system",
  category: "injected-context",
  parts: [part("Date"), part("Model")],
});
const ctx = {
  blocks: [block(0, "tools"), block(1, "tools", { basis: "estimate" }), block(2, "system"), merged],
  sections: { tools: 20, system: 10, messages: 10, framing: 0 },
  partTotals: [{ category: "injected-context", label: "Date", tokens: 5 }],
  turns: [],
  totalTokens: 40,
} as unknown as CallContext;
const shape = (rows: Row[]) =>
  rows.map((r) =>
    r.type === "section"
      ? `${r.open ? "v" : ">"} ${r.section}`
      : r.type === "part"
        ? `  ${r.part.label}`
        : r.type === "block"
          ? r.block.position
          : r.type,
  );

describe("the open sections of the block list", () => {
  test("by default the hidden part is closed, the messages are open and parts are folded", () => {
    expect(shape(listRows(ctx, "", DEFAULT_COLLAPSE))).toEqual(["> tools", "> system", "v messages", 3]);
  });

  test("a closed section is one row that sums its blocks: count, tokens and the least exact basis, cache, cost", () => {
    const [tools] = listRows(ctx, "", DEFAULT_COLLAPSE);
    expect(tools).toMatchObject({ blocks: 2, tokens: 20, basis: "estimate", cached: 20, fresh: 0 });
    expect(tools?.type === "section" && tools.costUsd).toBeCloseTo(0.02);
  });

  test("a section opens and closes; a block shows its parts and its category's totals", () => {
    const s = toggleBlock(toggleSection(DEFAULT_COLLAPSE, "tools"), merged);
    expect(shape(listRows(ctx, "", s))).toEqual(["v tools", 0, 1, "> system", "v messages", 3, "  Date", "  Model"]);
    expect(s.cats).toEqual(["injected-context"]);
    expect(shape(listRows(ctx, "", toggleBlock(s, merged)))).toEqual(["v tools", 0, 1, "> system", "v messages", 3]);
  });

  test("expand all opens every section and part, collapse all closes them", () => {
    const all = expandAll(DEFAULT_COLLAPSE, ctx);
    expect(shape(listRows(ctx, "", all))).toEqual([
      "v tools",
      0,
      1,
      "v system",
      2,
      "v messages",
      3,
      "  Date",
      "  Model",
    ]);
    expect(all.cats).toEqual(["injected-context"]);
    expect(shape(listRows(ctx, "", collapseAll()))).toEqual(["> tools", "> system", "> messages"]);
  });

  test("a search opens the sections and the block it finds in, and leaves the stored state as it was", () => {
    expect(shape(listRows(ctx, "model", collapseAll()))).toEqual(["v messages", 3, "  Model"]);
    expect(shape(listRows(ctx, "tool schema", collapseAll()))).toEqual(["v tools", 0, 1]);
  });

  test("a link to a block opens its section", () => {
    expect(revealBlock(DEFAULT_COLLAPSE, block(2, "system"), ctx).open.system).toBe(true);
  });

  test("a category of the token shares shows its parts with the list's, and opens their section", () => {
    const s = toggleCategory(collapseAll(), ctx, "injected-context");
    expect(s.cats).toEqual(["injected-context"]);
    expect(shape(listRows(ctx, "", s))).toEqual(["> tools", "> system", "v messages", 3, "  Date", "  Model"]);
    expect(toggleCategory(s, ctx, "injected-context")).toMatchObject({ cats: [], blocks: [] });
  });

  test("is read back as stored, with defaults for what is missing or not readable", () => {
    const s = toggleBlock(toggleSection(DEFAULT_COLLAPSE, "system"), merged);
    expect(readCollapse(JSON.stringify(s))).toEqual(s);
    expect(readCollapse(JSON.stringify({ open: { tools: true } }))).toEqual({
      ...DEFAULT_COLLAPSE,
      open: { ...DEFAULT_COLLAPSE.open, tools: true },
    });
    expect(readCollapse("{not json")).toEqual(DEFAULT_COLLAPSE);
    expect(readCollapse(null)).toEqual(DEFAULT_COLLAPSE);
  });
});

describe("the output section", () => {
  const entry = (kind: ResponseEntry["kind"], extra: Partial<ResponseEntry> = {}) =>
    ({
      hash: kind,
      kind,
      category: "assistant",
      source: {},
      preview: "",
      chars: 0,
      truncated: false,
      ...extra,
    }) as ResponseEntry;
  const resp = {
    call: { usage: { basis: "exact" } },
    answered: true,
    blocks: [
      entry("reasoning"),
      entry("assistant", { preview: "done" }),
      entry("tool-call", { toolCall: { id: "t", name: "Read" } }),
    ],
    stopReason: "tool_use",
    outputTokens: 300,
    outputUsd: 0.0045,
  } as unknown as CallResponseDetail;

  test("a header with the output's tokens and cost, a row per block, then the call that sends it back", () => {
    const rows = outputRows(resp, { next: 9 });
    expect(rows[0]).toMatchObject({ type: "section", section: "output", blocks: 3, tokens: 300, costUsd: 0.0045 });
    expect(shape(rows)).toEqual(["v output", "output", "output", "output", "note"]);
    expect(rows.at(-1)).toEqual({ type: "note", note: "answered", next: 9, stopReason: "tool_use" });
  });

  test("closed it is its header only; a search finds a tool call by its tool", () => {
    expect(shape(outputRows(resp, { open: false }))).toEqual(["> output"]);
    expect(shape(outputRows(resp, { open: false, find: "read" }))).toEqual(["v output", "output", "note"]);
    expect(outputRows(resp, { find: "nothing like it" })).toEqual([]);
  });

  test("with no answer yet it waits on the latest call, and says none was logged on an earlier one", () => {
    const none = { ...resp, answered: false, blocks: [] };
    expect(outputRows(none).at(-1)).toEqual({ type: "note", note: "waiting" });
    expect(outputRows(none, { next: 4 }).at(-1)).toEqual({ type: "note", note: "none" });
  });
});
