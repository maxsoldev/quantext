/** Cost of a Usage from a price sheet, and each Block's share of it. The prices themselves are provider data. */
import type { Cost, PriceRef, Usage } from "@quantext/shared";

/** The prices that apply to one Call, in US dollars per million tokens, after every price modifier. */
export interface PriceSheet extends PriceRef {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

/** The cost of a Usage by part. A cache write with no time-to-live split is priced as 5 minutes. */
export function costOf(usage: Usage, sheet: PriceSheet): Cost {
  const usd = (tokens: number, perMillion: number) => (tokens * perMillion) / 1_000_000;
  const split = usage.cacheWrite5mTokens !== undefined && usage.cacheWrite1hTokens !== undefined;
  const write5m = split ? (usage.cacheWrite5mTokens ?? 0) : usage.cacheWriteTokens;
  const write1h = split ? (usage.cacheWrite1hTokens ?? 0) : 0;
  const inputUsd = usd(usage.inputTokens, sheet.input);
  const cacheReadUsd = usd(usage.cacheReadTokens, sheet.cacheRead);
  const cacheWriteUsd = usd(write5m, sheet.cacheWrite5m) + usd(write1h, sheet.cacheWrite1h);
  const outputUsd = usd(usage.outputTokens, sheet.output);
  const { model, source, date, modifiers } = sheet;
  return {
    inputUsd,
    cacheReadUsd,
    cacheWriteUsd,
    outputUsd,
    totalUsd: inputUsd + cacheReadUsd + cacheWriteUsd + outputUsd,
    price: { model, source, date, modifiers },
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
