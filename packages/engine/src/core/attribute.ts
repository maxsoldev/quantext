/**
 * Token attribution (ADR 6): split each Call's exact input total over its Blocks. Exact numbers first: Blocks kept
 * from the previous Call keep their tokens, so the change of the total is exactly the tokens of the new Blocks.
 * Only a part that holds several new Blocks is split by estimate, and that split is scaled to add up to the part.
 */
import type { CallIssue, TokenBasis, Usage } from "@quantext/shared";
import type { Estimate } from "./estimate.ts";

export interface AttributionBlock {
  /** Content hash: Blocks with the same hash carry tokens from the previous Call. */
  hash: string;
  estimate: Estimate;
  cacheBreakpoint: boolean;
}

export interface AttributionCall {
  id: string;
  /** The Call whose Blocks this Call may keep (the base of its request, or the Call before it). */
  previousId?: string;
  /** Tokens are carried only between Calls of the same model: tokenizers differ. */
  model: string;
  usage?: Usage;
  /** In the order the provider reads them. */
  blocks: AttributionBlock[];
}

export interface BlockTokens {
  tokens: number;
  basis: TokenBasis;
  /** Inside the part of the input that the provider read from its cache. */
  inCachedPrefix: boolean;
}

export interface Attribution {
  /** One per input Block; absent when the Call has no Usage. */
  blocks?: BlockTokens[];
  /** Input tokens after the last Block (the end of the request), known from the cache split; else 0. */
  framingTokens: number;
  issues: CallIssue[];
}

/** A cache read within this share of a breakpoint's estimated position is taken as an exact split there. */
const CACHE_READ_TOLERANCE = 0.15;

/** Attribute every Call, in order; a Call can carry tokens only from a Call before it. */
export function attributeCalls(calls: readonly AttributionCall[]): Map<string, Attribution> {
  const done = new Map<string, { call: AttributionCall; result: Attribution }>();
  for (const call of calls) {
    const previous = call.previousId === undefined ? undefined : done.get(call.previousId);
    const carry = previous?.call.model === call.model ? previous : undefined;
    done.set(call.id, { call, result: attributeOne(call, carry?.call, carry?.result) });
  }
  return new Map([...done].map(([id, { result }]) => [id, result]));
}

function attributeOne(call: AttributionCall, previous?: AttributionCall, before?: Attribution): Attribution {
  const { usage, blocks } = call;
  if (usage === undefined) {
    return {
      framingTokens: 0,
      issues: [{ kind: "no-usage", detail: "the log has no response with usage for this call" }],
    };
  }
  const total = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
  const cached = usage.cacheReadTokens + usage.cacheWriteTokens;
  const last = blocks.length - 1;
  const lastBreakpoint = blocks.findLastIndex((b) => b.cacheBreakpoint);
  const framingTokens = cached > 0 && lastBreakpoint === last && last >= 0 ? usage.inputTokens : 0;
  const anchors: Anchor[] = [{ end: blocks.length, sum: total - framingTokens }];
  if (cached > 0 && lastBreakpoint >= 0 && lastBreakpoint < last)
    anchors.push({ end: lastBreakpoint + 1, sum: cached });

  const issues: CallIssue[] = [];
  const kept = previous && before?.blocks ? carried(blocks, previous, before.blocks) : blocks.map(() => undefined);
  let split = splitByAnchors(blocks, kept, withCacheRead(anchors, blocks, kept, usage), usage.basis);
  if (typeof split === "string") {
    issues.push({ kind: "unreconciled-tokens", detail: split });
    const fresh = blocks.map(() => undefined);
    const retry = splitByAnchors(blocks, fresh, withCacheRead(anchors, blocks, fresh, usage), usage.basis);
    split = typeof retry === "string" ? splitByAnchors(blocks, fresh, [anchors[0] as Anchor], usage.basis) : retry;
  }
  const tokens = typeof split === "string" ? blocks.map(() => ({ tokens: 0, basis: "estimate" as const })) : split;
  const prefix = cachedPrefixLength(
    tokens.map((t) => t.tokens),
    usage.cacheReadTokens,
  );
  return {
    blocks: tokens.map((t, i) => ({ ...t, inCachedPrefix: i < prefix })),
    framingTokens,
    issues,
  };
}

/** An exact cumulative token count at the end of a Block range: Blocks [0, end) hold `sum` tokens. */
interface Anchor {
  end: number;
  sum: number;
}

type Kept = { tokens: number; basis: TokenBasis } | undefined;

/** The tokens each Block keeps from the previous Call, matched by content hash (each previous Block once). */
function carried(
  blocks: readonly AttributionBlock[],
  previous: AttributionCall,
  tokens: readonly BlockTokens[],
): Kept[] {
  const pool = new Map<string, BlockTokens[]>();
  previous.blocks.forEach((b, i) => {
    const t = tokens[i];
    if (t !== undefined) pool.set(b.hash, [...(pool.get(b.hash) ?? []), t]);
  });
  return blocks.map((b) => {
    const t = pool.get(b.hash)?.shift();
    return t === undefined ? undefined : { tokens: t.tokens, basis: t.basis };
  });
}

/**
 * Add the cache read as an anchor when nothing is kept (a first call): the provider read its cache up to an earlier
 * breakpoint, so when the estimate puts one of this call's breakpoints near the cache read, the split is there.
 */
function withCacheRead(anchors: Anchor[], blocks: readonly AttributionBlock[], kept: readonly Kept[], usage: Usage) {
  const read = usage.cacheReadTokens;
  if (read === 0 || kept.some((k) => k !== undefined)) return anchors;
  let cumulative = 0;
  let best: { end: number; distance: number } | undefined;
  blocks.forEach((b, i) => {
    cumulative += b.estimate.tokens;
    const distance = Math.abs(cumulative - read);
    if (b.cacheBreakpoint && (best === undefined || distance < best.distance)) best = { end: i + 1, distance };
  });
  if (best === undefined || best.distance > read * CACHE_READ_TOLERANCE) return anchors;
  if (anchors.some((a) => a.end === best?.end)) return anchors;
  return [...anchors, { end: best.end, sum: read }];
}

/** Split each range between anchors over its new Blocks; a reason string when the numbers do not fit. */
function splitByAnchors(
  blocks: readonly AttributionBlock[],
  kept: readonly Kept[],
  anchors: readonly Anchor[],
  basis: TokenBasis,
): { tokens: number; basis: TokenBasis }[] | string {
  const out: { tokens: number; basis: TokenBasis }[] = [];
  let start = 0;
  let sumBefore = 0;
  for (const anchor of [...anchors].sort((a, b) => a.end - b.end)) {
    const range = blocks.slice(start, anchor.end).map((block, i) => ({ block, kept: kept[start + i] }));
    const keptSum = range.reduce((sum, r) => sum + (r.kept?.tokens ?? 0), 0);
    const rest = anchor.sum - sumBefore - keptSum;
    const fresh = range.filter((r) => r.kept === undefined);
    if (rest < 0)
      return `blocks kept from the previous call have ${keptSum} tokens, more than ${anchor.sum - sumBefore}`;
    if (fresh.length === 0 && rest !== 0) return `${rest} tokens more than the previous call, but no new block`;
    const shares = reconcile(
      fresh.map((r) => r.block.estimate),
      rest,
    );
    const freshBasis: TokenBasis = fresh.length === 1 ? basis : "estimate";
    let next = 0;
    for (const r of range) out.push(r.kept ?? { tokens: shares[next++] ?? 0, basis: freshBasis });
    start = anchor.end;
    sumBefore = anchor.sum;
  }
  return out;
}

/**
 * Integer shares of `total` in proportion to the estimates, adding up to `total` exactly (largest remainder).
 * Blocks with an unknown estimate share what the known estimates leave; with no weight at all, shares are equal.
 */
export function reconcile(estimates: readonly Estimate[], total: number): number[] {
  const known = estimates.reduce((sum, e) => sum + (e.method === "unknown" ? 0 : e.tokens), 0);
  const unknownCount = estimates.filter((e) => e.method === "unknown").length;
  let weights = estimates.map((e) => (e.method === "unknown" ? 0 : e.tokens));
  if (unknownCount > 0 && known < total) {
    const each = (total - known) / unknownCount;
    weights = estimates.map((e) => (e.method === "unknown" ? each : e.tokens));
  }
  const weightSum = weights.reduce((a, b) => a + b, 0);
  if (weightSum === 0) weights = estimates.map(() => 1);
  const sum = weightSum === 0 ? estimates.length : weightSum;
  const exact = weights.map((w) => (w * total) / sum);
  const shares = exact.map(Math.floor);
  const left = total - shares.reduce((a, b) => a + b, 0);
  const order = exact.map((x, i) => ({ i, frac: x - Math.floor(x) })).sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; k < left; k++) {
    const target = order[k % order.length];
    if (target !== undefined) shares[target.i] = (shares[target.i] ?? 0) + 1;
  }
  return shares;
}

/** The number of leading Blocks in the cached prefix: up to the Block boundary nearest the cache read. */
function cachedPrefixLength(tokens: readonly number[], cacheRead: number): number {
  if (cacheRead === 0) return 0;
  let best = 0;
  let bestDistance = cacheRead;
  let cumulative = 0;
  tokens.forEach((t, i) => {
    cumulative += t;
    const distance = Math.abs(cumulative - cacheRead);
    if (distance < bestDistance) [best, bestDistance] = [i + 1, distance];
  });
  return best;
}
