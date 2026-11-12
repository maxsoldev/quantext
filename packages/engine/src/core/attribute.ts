/**
 * Token attribution (ADR 6): split one Call's exact input total over its Blocks. Exact numbers first: Blocks kept
 * from the previous Call keep their tokens, so the change of the total is the tokens of the new Blocks. A part with
 * several new Blocks is split by estimate and scaled to add up to it: those Blocks form a group whose sum is exact.
 * A subtraction is exact only when every group it subtracts is whole; otherwise the rest is an estimate too.
 */
import type { CallIssue, TokenBasis, Usage } from "@quantext/shared";
import type { Estimate } from "./estimate.ts";

/** A Block's tokens, how they were found, and the group whose sum is exact (absent for an exact Block). */
export interface Share {
  tokens: number;
  basis: TokenBasis;
  group?: string;
}

/** The leading Blocks that the Call keeps from the previous Call, unchanged. */
export interface KeptPrefix {
  count: number;
  tokens: number;
  /** Every group in the prefix is whole and no Block in it is a lone estimate: its sum is exact. */
  exact: boolean;
  /** The estimates of the kept Blocks; read only when the kept tokens do not fit the total. */
  estimates: () => readonly Estimate[];
}

/** A Block after the kept prefix. `carried`: the same content was in the previous Call, with these tokens. */
export interface FreshBlock {
  estimate: Estimate;
  carried?: Share;
}

export interface CallAttributionInput {
  /** The Call's id, the prefix of its new group ids. */
  id: string;
  usage: Usage;
  kept: KeptPrefix;
  fresh: readonly FreshBlock[];
  /** Position of the last Block that carries a cache breakpoint. */
  lastBreakpoint?: number;
  /** The size of a group, so that a group carried whole by content counts as exact. */
  groupSize?: (group: string) => number;
}

export interface CallAttribution {
  fresh: Share[];
  /** New shares of the kept Blocks, when the kept tokens did not fit and the whole total was split again. */
  kept?: Share[];
  /** Input tokens after the last Block (the end of the request), known from the cache split; else 0. */
  framingTokens: number;
  issues: CallIssue[];
  /** The new groups and their sizes. */
  groups: { id: string; size: number }[];
}

/** Attribute one Call's input total to its kept and new Blocks. */
export function attributeCall(input: CallAttributionInput): CallAttribution {
  const { usage, kept, fresh } = input;
  const total = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
  const cached = usage.cacheReadTokens + usage.cacheWriteTokens;
  const count = kept.count + fresh.length;
  const lastBp = input.lastBreakpoint;
  const framingTokens = cached > 0 && lastBp === count - 1 && count > 0 ? usage.inputTokens : 0;
  const anchors: Anchor[] = [{ end: count, sum: total - framingTokens }];
  if (cached > 0 && lastBp !== undefined && lastBp >= kept.count && lastBp < count - 1) {
    anchors.unshift({ end: lastBp + 1, sum: cached });
  }
  const split = splitFresh(input, anchors);
  if (typeof split !== "string") return { ...split, framingTokens, issues: [] };
  // The kept tokens do not fit: split the whole total again, over every Block, by estimate.
  const all = [...kept.estimates(), ...fresh.map((f) => f.estimate)].map((estimate) => ({ estimate }));
  const again = splitFresh({ ...input, kept: { ...kept, count: 0, tokens: 0, exact: true }, fresh: all }, [
    { end: count, sum: total - framingTokens },
  ]);
  const shares = typeof again === "string" ? all.map(() => ({ tokens: 0, basis: "estimate" as const })) : again.fresh;
  return {
    kept: shares.slice(0, kept.count),
    fresh: shares.slice(kept.count),
    framingTokens,
    issues: [{ kind: "unreconciled-tokens", detail: split }],
    groups: typeof again === "string" ? [] : again.groups,
  };
}

/** Blocks [0, end) hold `sum` tokens, exactly. */
interface Anchor {
  end: number;
  sum: number;
}

/** Split each range between anchors over its new Blocks; a reason when the kept tokens do not fit. */
function splitFresh(
  input: CallAttributionInput,
  anchors: readonly Anchor[],
): Omit<CallAttribution, "framingTokens" | "issues"> | string {
  const { kept, fresh, usage, id } = input;
  const out: Share[] = [];
  const groups: { id: string; size: number }[] = [];
  let start = kept.count;
  let sumBefore = kept.tokens;
  let exactBefore = kept.exact;
  for (const [rangeIndex, anchor] of anchors.entries()) {
    const range = fresh.slice(start - kept.count, anchor.end - kept.count);
    const carriedSum = range.reduce((sum, f) => sum + (f.carried?.tokens ?? 0), 0);
    const carriedPerGroup = new Map<string, number>();
    for (const f of range) {
      const g = f.carried?.group;
      if (g !== undefined) carriedPerGroup.set(g, (carriedPerGroup.get(g) ?? 0) + 1);
    }
    const whole = (g: string | undefined) => g !== undefined && carriedPerGroup.get(g) === input.groupSize?.(g);
    const exact =
      exactBefore &&
      range.every((f) => f.carried === undefined || f.carried.basis !== "estimate" || whole(f.carried.group));
    const rest = anchor.sum - sumBefore - carriedSum;
    const fresher = range.filter((f) => f.carried === undefined);
    if (rest < 0)
      return `blocks kept from the previous call have ${sumBefore + carriedSum} tokens, more than ${anchor.sum}`;
    if (fresher.length === 0 && rest !== 0) return `${rest} tokens more than the previous call, but no new block`;
    const shares = reconcile(
      fresher.map((f) => f.estimate),
      rest,
    );
    const group = exact && fresher.length > 1 ? `${id}#${rangeIndex}` : undefined;
    if (group !== undefined) groups.push({ id: group, size: fresher.length });
    let next = 0;
    for (const f of range) {
      if (f.carried !== undefined) {
        out.push(f.carried);
        continue;
      }
      const tokens = shares[next++] ?? 0;
      if (fresher.length === 1 && exact) out.push({ tokens, basis: usage.basis });
      else out.push(group === undefined ? { tokens, basis: "estimate" } : { tokens, basis: "estimate", group });
    }
    start = anchor.end;
    sumBefore = anchor.sum;
    exactBefore = true; // an anchor is an exact edge
  }
  return { fresh: out, groups };
}

/**
 * Integer shares of `total` in proportion to the estimates, adding up to `total` exactly (largest remainder).
 * `rest` and `unknown` Blocks share what the known estimates leave (`rest` by tokens, `unknown` equally); with no
 * weight at all, shares are equal.
 */
export function reconcile(estimates: readonly Estimate[], total: number): number[] {
  const leftover = (e: Estimate) => e.method === "unknown" || e.method === "rest";
  const known = estimates.reduce((sum, e) => sum + (leftover(e) ? 0 : e.tokens), 0);
  let weights = estimates.map((e) => (leftover(e) ? 0 : e.tokens));
  if (estimates.some(leftover) && known < total) {
    const rest = estimates.filter((e) => e.method === "rest");
    const restWeight = rest.reduce((sum, e) => sum + e.tokens, 0);
    const unknownWeight = Math.max(1, rest.length === 0 ? 1 : restWeight / rest.length);
    const parts = estimates.map((e) => (e.method === "rest" ? e.tokens : e.method === "unknown" ? unknownWeight : 0));
    const partSum = parts.reduce((a, b) => a + b, 0);
    const share = (part: number) =>
      partSum === 0 ? (total - known) / estimates.filter(leftover).length : ((total - known) * part) / partSum;
    weights = estimates.map((e, i) => (leftover(e) ? share(parts[i] ?? 0) : e.tokens));
  }
  if (weights.reduce((a, b) => a + b, 0) === 0) weights = estimates.map(() => 1);
  const sum = weights.reduce((a, b) => a + b, 0);
  const exact = weights.map((w) => (sum === 0 ? 0 : (w * total) / sum));
  const shares = exact.map(Math.floor);
  const left = total - shares.reduce((a, b) => a + b, 0);
  const order = exact.map((x, i) => ({ i, frac: x - Math.floor(x) })).sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; k < left; k++) {
    const target = order[k % order.length];
    if (target !== undefined) shares[target.i] = (shares[target.i] ?? 0) + 1;
  }
  return shares;
}

/**
 * The number of leading Blocks that end inside the cache read, from the prefix sums of their tokens
 * (`prefix(i)` is the tokens of Blocks [0, i)). A Block the cache read ends inside is not counted.
 */
export function cachedPrefixLength(prefix: (i: number) => number, count: number, cacheRead: number): number {
  let lo = 0;
  let hi = count;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (prefix(mid) <= cacheRead) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}
