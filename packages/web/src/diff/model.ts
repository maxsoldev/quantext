/**
 * What changed at Call N against the Call before it, as two strips on one token scale: each Block of the previous
 * Call (kept or removed) and of this Call (kept, moved or added), with the end of each Call's cached prefix.
 */
import type {
  CacheBreak,
  CacheBreakReason,
  CallContext,
  ContextBlock,
  ContextCategory,
  ContextDiff,
} from "@quantext/shared";

export type ChangeStatus = "kept" | "added" | "removed" | "moved";

export interface StripSegment {
  block: ContextBlock;
  status: ChangeStatus;
  category: ContextCategory;
  /** Kept, but no longer in the cached prefix: written to the cache again. */
  rewritten: boolean;
  /** Percent of the longer of the two Calls' inputs. */
  left: number;
  width: number;
}

export interface Strip {
  segments: StripSegment[];
  /** Where the cached prefix ends, in percent; 0 when nothing was read from the cache. */
  cachedTo: number;
  /** Where this Call first differs from the previous one, in percent (current strip only). */
  firstChange?: number;
}

export interface ChangeTotal {
  blocks: number;
  tokens: number;
}

export interface DiffView {
  before: Strip;
  now: Strip;
  totals: Record<"added" | "removed" | "moved" | "uncached", ChangeTotal>;
}

export function diffView(prev: CallContext | undefined, ctx: CallContext, diff: ContextDiff): DiffView {
  const scale = Math.max(1, prev?.totalTokens ?? 0, ctx.totalTokens);
  const removed = new Set(diff.removed.map((b) => b.position));
  const added = new Set(diff.added.map((b) => b.position));
  const moved = new Set(diff.moved.map((b) => b.position));
  const uncached = new Set(diff.uncached.map((b) => b.position));
  const before = prev
    ? strip(
        prev,
        scale,
        (b) => (removed.has(b.position) ? "removed" : "kept"),
        () => false,
      )
    : { segments: [], cachedTo: 0 };
  const now = strip(
    ctx,
    scale,
    (b) => (added.has(b.position) ? "added" : moved.has(b.position) ? "moved" : "kept"),
    (b) => uncached.has(b.position),
  );
  if (diff.firstChange !== undefined) {
    const at = now.segments.find((s) => s.block.position >= (diff.firstChange as number));
    now.firstChange = at ? at.left : percentOf(ctx.totalTokens, scale);
  }
  return {
    before,
    now,
    totals: {
      added: total(diff.added),
      removed: total(diff.removed),
      moved: total(diff.moved),
      uncached: total(diff.uncached),
    },
  };
}

function strip(
  ctx: CallContext,
  scale: number,
  status: (b: ContextBlock) => ChangeStatus,
  rewritten: (b: ContextBlock) => boolean,
): Strip {
  let at = 0;
  const segments = [...ctx.blocks]
    .sort((a, b) => a.position - b.position)
    .map((block) => {
      const t = block.tokens ?? 0;
      const s: StripSegment = {
        block,
        status: status(block),
        category: block.category,
        rewritten: rewritten(block),
        left: percentOf(at, scale),
        width: percentOf(t, scale),
      };
      at += t;
      return s;
    });
  const read = Math.min(ctx.call.usage?.cacheReadTokens ?? 0, ctx.totalTokens);
  return { segments, cachedTo: percentOf(read, scale) };
}

function percentOf(n: number, scale: number): number {
  return (100 * n) / scale;
}

function total(blocks: readonly ContextBlock[]): ChangeTotal {
  return { blocks: blocks.length, tokens: blocks.reduce((n, b) => n + (b.tokens ?? 0), 0) };
}

/** A lane's cache breaks by reason (most first), and the breaks just before and after Call `call`. */
export function breakSummary(
  breaks: readonly CacheBreak[],
  call: number,
): { counts: [CacheBreakReason, number][]; previous?: CacheBreak | undefined; next?: CacheBreak | undefined } {
  const counts = new Map<CacheBreakReason, number>();
  for (const b of breaks) counts.set(b.reason, (counts.get(b.reason) ?? 0) + 1);
  const sorted = [...breaks].sort((a, b) => a.index - b.index);
  return {
    counts: [...counts].sort((a, b) => b[1] - a[1]),
    previous: sorted.filter((b) => b.index < call).at(-1),
    next: sorted.find((b) => b.index > call),
  };
}
