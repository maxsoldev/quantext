/**
 * Anthropic list prices as data, the mapping of provider model ids to canonical ids, and the price modifiers
 * (Bedrock regional endpoints, fast mode, US-only inference, Haiku 5.5's prompt-size tier).
 */
import type { CallIssue, Cost, Usage } from "@quantext/shared";
import type { PriceSheet } from "../../core/pricing.ts";
import { costOf } from "../../core/pricing.ts";

export const PRICE_SOURCE = "https://platform.claude.com/docs/en/about-claude/pricing";
const DATE = "2026-11-12";

interface ModelPrice {
  /** US dollars per million tokens. */
  input: number;
  output: number;
  cacheRead: number;
  /** Fast-mode input and output prices, where the model has fast mode. */
  fast?: { input: number; output: number };
  /** Bedrock regional endpoints cost 10% more for Claude 4.5 models and later. */
  regionalPremium: boolean;
  /** `inference_geo: "us"` costs 1.1x for Claude 4.6 models and later. */
  usOnlyPremium: boolean;
  /** Prices above a prompt size (all input tokens, cache included). */
  longPrompt?: { over: number; input: number; output: number; cacheRead: number };
  /** The 1M context is at standard prices (Claude 4.6 and later); else a long prompt is flagged. */
  longContextVerified: boolean;
}

/** Cache writes cost a multiple of the input price, by time to live. */
const CACHE_WRITE_5M = 1.25;
const CACHE_WRITE_1H = 2;
const PREMIUM = 1.1;
/** Above this prompt size a `[1m]` model before Claude 4.6 may have a long-context price that is not modelled. */
const LONG_CONTEXT = 200_000;

const p = (input: number, output: number, cacheRead: number, more: Partial<ModelPrice> = {}): ModelPrice => ({
  input,
  output,
  cacheRead,
  regionalPremium: true,
  usOnlyPremium: true,
  longContextVerified: true,
  ...more,
});
const BEFORE_4_6 = { usOnlyPremium: false, longContextVerified: false };
const BEFORE_4_5 = { ...BEFORE_4_6, regionalPremium: false };

/** Anthropic first-party list prices per million tokens, from PRICE_SOURCE on DATE. */
const PRICES: Record<string, ModelPrice> = {
  "claude-fable-5-2": p(8, 40, 0.2, { fast: { input: 16, output: 80 } }),
  "claude-mythos-5-2": p(8, 40, 0.2, { fast: { input: 16, output: 80 } }),
  "claude-fable-5-1": p(10, 50, 0.25),
  "claude-mythos-5-1": p(10, 50, 0.25),
  "claude-fable-5": p(10, 50, 1),
  "claude-mythos-5": p(10, 50, 1),
  "claude-opus-5-5": p(4, 20, 0.2, { fast: { input: 8, output: 40 } }),
  "claude-opus-5": p(5, 25, 0.5, { fast: { input: 10, output: 50 } }),
  "claude-opus-4-8": p(5, 25, 0.5, { fast: { input: 10, output: 50 } }),
  "claude-opus-4-7": p(5, 25, 0.5),
  "claude-opus-4-6": p(5, 25, 0.5),
  "claude-opus-4-5": p(5, 25, 0.5, BEFORE_4_6),
  "claude-opus-4-1": p(15, 75, 1.5, BEFORE_4_5),
  "claude-opus-4": p(15, 75, 1.5, BEFORE_4_5),
  "claude-sonnet-5-5": p(2, 10, 0.1),
  "claude-sonnet-5": p(2, 10, 0.2),
  "claude-sonnet-4-6": p(3, 15, 0.3),
  "claude-sonnet-4-5": p(3, 15, 0.3, BEFORE_4_6),
  "claude-sonnet-4": p(3, 15, 0.3, BEFORE_4_5),
  "claude-haiku-5-5": p(0.1, 0.5, 0.01, { longPrompt: { over: 100_000, input: 0.5, output: 2.5, cacheRead: 0.05 } }),
  "claude-haiku-4-5": p(1, 5, 0.1, BEFORE_4_6),
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

export interface PriceContext {
  /** The model id as requested (with any provider prefix). */
  model: string;
  /** `usage.speed`: `fast` for fast mode. */
  speed?: string;
  /** `usage.inference_geo`: `us` for US-only inference. */
  inferenceGeo?: string;
}

/** The cost of one Call, with the modifiers that applied, and what had to be assumed. */
export function priceCall(usage: Usage, context: PriceContext): { cost?: Cost; issues: CallIssue[] } {
  const model = canonicalModel(context.model);
  const price = model === undefined ? undefined : PRICES[model];
  if (model === undefined || price === undefined) {
    return { issues: [{ kind: "no-price", detail: `no list price for model ${context.model}` }] };
  }
  const prompt = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
  const sheet = sheetFor(model, price, context, prompt);
  return { cost: costOf(usage, sheet), issues: assumptions(usage, model, price, context, prompt) };
}

function sheetFor(model: string, price: ModelPrice, context: PriceContext, prompt: number): PriceSheet {
  const modifiers: string[] = [];
  let { input, output, cacheRead } = price;
  if (price.longPrompt !== undefined && prompt > price.longPrompt.over) {
    ({ input, output, cacheRead } = price.longPrompt);
    modifiers.push(`prompt over ${price.longPrompt.over} tokens`);
  }
  if (context.speed === "fast" && price.fast !== undefined) {
    cacheRead = price.fast.input * (cacheRead / input);
    ({ input, output } = price.fast);
    modifiers.push("fast mode");
  }
  let factor = 1;
  if (price.regionalPremium && isBedrockRegional(context.model)) {
    factor *= PREMIUM;
    modifiers.push("Bedrock regional endpoint +10%");
  }
  if (price.usOnlyPremium && context.inferenceGeo === "us") {
    factor *= PREMIUM;
    modifiers.push("US-only inference x1.1");
  }
  return {
    model,
    source: PRICE_SOURCE,
    date: DATE,
    modifiers,
    input: input * factor,
    output: output * factor,
    cacheRead: cacheRead * factor,
    cacheWrite5m: input * CACHE_WRITE_5M * factor,
    cacheWrite1h: input * CACHE_WRITE_1H * factor,
  };
}

/** A Bedrock id with a geographic prefix (`eu.`, `us.`, `apac.`, `us-gov.`, …) is regional; `global.` and a bare id are not. */
function isBedrockRegional(id: string): boolean {
  const prefix = /^([a-z-]+)\.anthropic\./.exec(id)?.[1];
  return prefix !== undefined && prefix !== "global";
}

function assumptions(
  usage: Usage,
  model: string,
  price: ModelPrice,
  context: PriceContext,
  prompt: number,
): CallIssue[] {
  const issues: CallIssue[] = [];
  const { cacheWriteTokens: write, cacheWrite5mTokens: w5, cacheWrite1hTokens: w1 } = usage;
  if (w5 === undefined || w1 === undefined) {
    if (write > 0)
      issues.push({ kind: "price-assumption", detail: "cache write time to live unknown; priced as 5 minutes" });
  } else if (w5 + w1 !== write) {
    issues.push({
      kind: "price-assumption",
      detail: `cache write ${write} is not 5m ${w5} + 1h ${w1}; priced by the split`,
    });
  }
  if (!price.longContextVerified && /\[1m\]$/.test(context.model) && prompt > LONG_CONTEXT) {
    const detail = `prompt over ${LONG_CONTEXT} tokens on ${model}: long-context price not verified`;
    issues.push({ kind: "price-assumption", detail });
  }
  return issues;
}
