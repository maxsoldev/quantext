import type { CompactionDetail, ContextCategory, TokenGroup } from "@quantext/shared";
import { describe, expect, test } from "vitest";
import type { CompactionView } from "./model.ts";
import { compactionView } from "./model.ts";

const group = (parts: Partial<Record<ContextCategory, number>>): TokenGroup => {
  const categories = {
    "tool-definitions": 0,
    "base-instructions": 0,
    "injected-context": 0,
    user: 0,
    assistant: 0,
    reasoning: 0,
    "tool-calls": 0,
    "tool-outputs": 0,
    "compaction-summary": 0,
    other: 0,
    ...parts,
  };
  return { blocks: 1, tokens: Object.values(categories).reduce((a, b) => a + b, 0), categories };
};

const compaction = (c: Partial<CompactionDetail>): CompactionDetail => ({
  id: "c",
  sessionId: "s",
  ts: "2026-11-12T00:00:00Z",
  trigger: "auto",
  ...c,
});

describe("a compaction, before and after", () => {
  const c = compaction({
    removed: group({ "tool-outputs": 300, user: 100 }),
    kept: group({ "tool-definitions": 500, "base-instructions": 100 }),
    summaryTokens: 50,
  });
  const v = compactionView(c, 700) as CompactionView;

  test("before: what was kept, then what was removed, by category, in request order", () => {
    expect(v.before.map((s) => [s.part, s.category, s.tokens])).toEqual([
      ["kept", "tool-definitions", 500],
      ["kept", "base-instructions", 100],
      ["removed", "user", 100],
      ["removed", "tool-outputs", 300],
    ]);
  });

  test("after: what was kept, the summary, and what the next call added", () => {
    expect(v.after.map((s) => [s.part, s.tokens])).toEqual([
      ["kept", 500],
      ["kept", 100],
      ["summary", 50],
      ["added", 50],
    ]);
  });

  test("both on one scale: the larger of before and after is 100%", () => {
    expect(v.before.at(-1)).toMatchObject({ left: 70, width: 30 });
    expect(v.after.at(-1)).toMatchObject({ left: 650 / 10, width: 5 });
  });

  test("its figures: removed, kept, the summary, and the share it freed", () => {
    expect(v.figures).toEqual({ before: 1000, removed: 400, kept: 600, summary: 50, after: 700, freed: 0.3 });
  });

  test("without block counts (no request log) there is nothing to draw", () => {
    expect(compactionView(compaction({ beforeTokens: 9000 }), undefined)).toBeUndefined();
  });
});
