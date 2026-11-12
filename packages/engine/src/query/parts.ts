/** The parts of a Block in a Call's context: their share of the Block's tokens, and totals by label. */
import type { BlockPart, ContextBlock, ContextPart, PartTotal, TokenBasis } from "@quantext/shared";
import { reconcile } from "../core/attribute.ts";
import { previewOf } from "./preview.ts";

/**
 * Each part with its text's preview and its share of `tokens`, in proportion to its characters (estimates that add
 * up to `tokens`). A Block's only part takes the Block's tokens and basis as they are.
 */
export function contextParts(
  text: string,
  parts: readonly BlockPart[],
  tokens: number | undefined,
  basis: TokenBasis | undefined,
  previewChars: number,
): ContextPart[] {
  const shares =
    tokens === undefined
      ? undefined
      : reconcile(
          parts.map((p) => ({ tokens: p.end - p.start, method: "chars" as const })),
          tokens,
        );
  return parts.map((p, i) => {
    const out: ContextPart = {
      label: p.label,
      source: p.source,
      start: p.start,
      end: p.end,
      ...previewOf(text.slice(p.start, p.end), previewChars),
    };
    const share = shares?.[i];
    if (share !== undefined) {
      out.tokens = share;
      const own = parts.length === 1 ? basis : "estimate";
      if (own !== undefined) out.basis = own;
    }
    return out;
  });
}

/** Tokens by category and part label over the context's Blocks, most first (ties by label). */
export function partTotals(blocks: readonly ContextBlock[]): PartTotal[] {
  const totals = new Map<string, PartTotal>();
  for (const b of blocks) {
    for (const p of b.parts ?? []) {
      const key = `${b.category}\u0000${p.label}`;
      const t = totals.get(key) ?? { category: b.category, label: p.label, tokens: 0 };
      t.tokens += p.tokens ?? 0;
      totals.set(key, t);
    }
  }
  return [...totals.values()].sort((a, b) => b.tokens - a.tokens || a.label.localeCompare(b.label));
}
