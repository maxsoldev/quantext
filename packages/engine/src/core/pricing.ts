/** Model list prices as data, the mapping of provider model ids to canonical ids, and the price of a Usage. */
import type { Cost, PriceRef, Usage } from "@quantext/shared";

interface ModelPrice {
  /** US dollars per million tokens. */
  input: number;
  output: number;
  cacheRead: number;
}

const SOURCE = "Anthropic first-party list prices (Claude API model table)";
const DATE = "2026-11-03";

/** Cache writes cost a multiple of the input price, by time to live. */
const CACHE_WRITE_5M = 1.25;
const CACHE_WRITE_1H = 2;

/**
 * Anthropic first-party list prices per million tokens. Cache reads are 0.1x input, except where the model's own
 * price differs (Opus 5.5, Sonnet 5.5, Fable). Opus 5.5 and Sonnet 4.5 are checked against the cost that Claude
 * Code logs. Long-context premiums (1M beta above 200K input) are not modelled.
 */
const PRICES: Record<string, ModelPrice> = {
  "claude-fable-5-2": { input: 8, output: 40, cacheRead: 0.2 },
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25 },
  "claude-fable-5": { input: 10, output: 50, cacheRead: 1 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-opus-4-7": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-opus-4-6": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-opus-4-5": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-opus-4-1": { input: 15, output: 75, cacheRead: 1.5 },
  "claude-opus-4": { input: 15, output: 75, cacheRead: 1.5 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.1 },
  "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2 },
  "claude-sonnet-4-6": { input: 3, output: 15, cacheRead: 0.3 },
  "claude-sonnet-4-5": { input: 3, output: 15, cacheRead: 0.3 },
  "claude-sonnet-4": { input: 3, output: 15, cacheRead: 0.3 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1 },
};

/**
 * The canonical id of a model id from any provider, or undefined when no price is known for it. Drops a Bedrock
 * region and `anthropic.` prefix, a `-v1:0` version, a `[1m]` context suffix, and a snapshot date (`-20250929`,
 * Vertex `@20251101`).
 */
export function canonicalModel(id: string): string | undefined {
  const base = id
    .replace(/\[[^\]]*\]$/, "")
    .replace(/^(?:[a-z-]+\.)?anthropic\./, "")
    .replace(/-v\d+(?::\d+)?$/, "")
    .replace(/(?:-|@)\d{8}$/, "");
  return base in PRICES ? base : undefined;
}

/** The cost of a Usage by part at the list price of a canonical model; undefined when the model has no price. */
export function priceUsage(usage: Usage, model: string): Cost | undefined {
  const price = PRICES[model];
  if (price === undefined) return undefined;
  const usd = (tokens: number, perMillion: number) => (tokens * perMillion) / 1_000_000;
  const split = usage.cacheWrite5mTokens !== undefined && usage.cacheWrite1hTokens !== undefined;
  const write5m = split ? (usage.cacheWrite5mTokens ?? 0) : usage.cacheWriteTokens;
  const write1h = split ? (usage.cacheWrite1hTokens ?? 0) : 0;
  const inputUsd = usd(usage.inputTokens, price.input);
  const cacheReadUsd = usd(usage.cacheReadTokens, price.cacheRead);
  const cacheWriteUsd = usd(write5m, price.input * CACHE_WRITE_5M) + usd(write1h, price.input * CACHE_WRITE_1H);
  const outputUsd = usd(usage.outputTokens, price.output);
  const ref: PriceRef = { model, source: SOURCE, date: DATE };
  return {
    inputUsd,
    cacheReadUsd,
    cacheWriteUsd,
    outputUsd,
    totalUsd: inputUsd + cacheReadUsd + cacheWriteUsd + outputUsd,
    price: ref,
  };
}

/**
 * Each Block's share of a Call's input cost, from its tokens in order. The provider reads the cache first, then
 * writes the cache up to the last breakpoint, then reads the rest as plain input: a Block is priced by the parts
 * of that range it covers (the cache write at its average price over both times to live).
 */
export function blockCosts(tokens: readonly number[], usage: Usage, cost: Cost): number[] {
  const perToken = (usd: number, n: number) => (n > 0 ? usd / n : 0);
  const readEnd = usage.cacheReadTokens;
  const writeEnd = readEnd + usage.cacheWriteTokens;
  const prices = [
    { from: 0, to: readEnd, price: perToken(cost.cacheReadUsd, usage.cacheReadTokens) },
    { from: readEnd, to: writeEnd, price: perToken(cost.cacheWriteUsd, usage.cacheWriteTokens) },
    { from: writeEnd, to: Number.POSITIVE_INFINITY, price: perToken(cost.inputUsd, usage.inputTokens) },
  ];
  let start = 0;
  return tokens.map((t) => {
    const [a, b] = [start, start + t];
    start = b;
    return prices.reduce((usd, r) => usd + Math.max(0, Math.min(b, r.to) - Math.max(a, r.from)) * r.price, 0);
  });
}
