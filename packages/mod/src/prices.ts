/**
 * What a cache write costs, by model family, for the expiry nudge's "~$". The list prices are the engine's
 * (packages/engine/src/providers/anthropic/pricing.ts); a 5-minute cache write is 1.25 times the input price.
 * The mod cannot import the engine, so the input prices are copied here.
 */
const CACHE_WRITE_5M = 1.25;

/** US dollars per million input tokens; the first match wins, so a longer id comes before its prefix. */
const INPUT_PRICE: readonly [RegExp, number][] = [
  [/(fable|mythos)-5-2/, 8],
  [/(fable|mythos)-5/, 10],
  [/opus-5-5/, 4],
  [/opus-4-1|opus-4(?!-)/, 15],
  [/opus/, 5],
  [/sonnet-5/, 2],
  [/sonnet/, 3],
  [/haiku-5-5/, 0.1],
  [/haiku/, 1],
];

/** US dollars for writing `tokens` to the 5-minute cache on `model`; undefined for a model with no known price. */
export function cacheWriteUsd(model: string, tokens: number): number | undefined {
  const price = INPUT_PRICE.find(([pattern]) => pattern.test(model))?.[1];
  return price === undefined ? undefined : (tokens * price * CACHE_WRITE_5M) / 1e6;
}
