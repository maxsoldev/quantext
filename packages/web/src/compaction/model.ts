/**
 * A compaction as two bars on one scale: the context before (kept, then removed, by category) and the context of
 * the first call after (by category, the summary last), with the figures that explain it.
 */
import type { CompactionDetail, ContextCategory } from "@quantext/shared";
import { CATEGORIES } from "../context/categories.ts";

export type CompactionPart = "kept" | "removed" | "summary" | "added" | "after";

export interface CompactionSegment {
  part: CompactionPart;
  category: ContextCategory;
  tokens: number;
  /** Percent of the larger of the two contexts. */
  left: number;
  width: number;
}

export interface CompactionView {
  before: CompactionSegment[];
  after: CompactionSegment[];
  figures: { before: number; removed: number; kept: number; summary: number; after: number; freed: number };
}

/**
 * `after`: the first call after: its input total (absent without usage) and, when rebuilt, its tokens by category.
 * With them, the after bar is that call's own context; without, kept plus summary plus the rest of its total.
 */
export function compactionView(
  c: CompactionDetail,
  after: { total?: number | undefined; categories?: Record<ContextCategory, number> | undefined },
): CompactionView | undefined {
  if (!c.removed || !c.kept) return undefined;
  const kept = parts("kept", c.kept.categories);
  const removed = parts("removed", c.removed.categories);
  const before = c.kept.tokens + c.removed.tokens;
  const own = after.categories;
  const summary = own ? own["compaction-summary"] : (c.summaryTokens ?? 0);
  const total = after.total ?? c.kept.tokens + summary;
  const added = Math.max(0, total - c.kept.tokens - summary);
  const afterParts = own
    ? [
        ...parts("after", { ...own, "compaction-summary": 0 }),
        ...(summary > 0
          ? [{ part: "summary" as const, category: "compaction-summary" as const, tokens: summary }]
          : []),
      ]
    : [
        ...kept,
        ...(summary > 0
          ? [{ part: "summary" as const, category: "compaction-summary" as const, tokens: summary }]
          : []),
        ...(added > 0 ? [{ part: "added" as const, category: "other" as const, tokens: added }] : []),
      ];
  const afterTotal = total;
  const scale = Math.max(1, before, afterTotal);
  return {
    before: place([...kept, ...removed], scale),
    after: place(afterParts, scale),
    figures: {
      before,
      removed: c.removed.tokens,
      kept: c.kept.tokens,
      summary,
      after: afterTotal,
      freed: before > 0 ? (before - afterTotal) / before : 0,
    },
  };
}

function parts(part: CompactionPart, categories: Record<ContextCategory, number>) {
  return CATEGORIES.filter((k) => categories[k.key] > 0).map((k) => ({
    part,
    category: k.key,
    tokens: categories[k.key],
  }));
}

function place(items: Omit<CompactionSegment, "left" | "width">[], scale: number): CompactionSegment[] {
  let at = 0;
  return items.map((s) => {
    const seg = { ...s, left: (100 * at) / scale, width: (100 * s.tokens) / scale };
    at += s.tokens;
    return seg;
  });
}
