/** Map Claude Code's request parameters and response usage to the domain's Call fields. */
import type { Call, CallParams, Usage } from "@quantext/shared";
import { priceCall } from "../../providers/anthropic/pricing.ts";
import type { Json, JsonObject } from "./json.ts";
import { arr, num, obj, str } from "./json.ts";

export function usageOf(raw: JsonObject): Usage {
  const usage: Usage = {
    basis: "exact",
    inputTokens: num(raw.input_tokens) ?? 0,
    cacheReadTokens: num(raw.cache_read_input_tokens) ?? 0,
    cacheWriteTokens: num(raw.cache_creation_input_tokens) ?? 0,
    outputTokens: num(raw.output_tokens) ?? 0,
  };
  const reasoning = num(obj(raw.output_tokens_details)?.thinking_tokens);
  if (reasoning !== undefined) usage.reasoningOutputTokens = reasoning;
  const ttl = obj(raw.cache_creation);
  const write5m = num(ttl?.ephemeral_5m_input_tokens);
  const write1h = num(ttl?.ephemeral_1h_input_tokens);
  if (write5m !== undefined && write1h !== undefined) {
    usage.cacheWrite5mTokens = write5m;
    usage.cacheWrite1hTokens = write1h;
  }
  return usage;
}

export function paramsOf(params: JsonObject): CallParams {
  const betas = [...(arr(params.betas) ?? []), ...(arr(params.anthropic_beta) ?? [])].filter(
    (beta): beta is string => typeof beta === "string",
  );
  const result: CallParams = {};
  const provider: { [key: string]: Json } = {};
  const maxTokens = num(params.max_tokens);
  if (maxTokens !== undefined) result.maxTokens = maxTokens;
  const thinking = obj(params.thinking);
  const mode = str(thinking?.type);
  if (thinking !== undefined && mode !== undefined) {
    const budget = num(thinking.budget_tokens);
    result.reasoning = budget === undefined ? { mode } : { mode, budgetTokens: budget };
    provider.thinking = thinking;
  }
  const effort = str(obj(params.output_config)?.effort);
  if (effort !== undefined) result.effort = effort;
  if (betas.length > 0) provider.betas = [...new Set(betas)];
  if (Object.keys(provider).length > 0) result.provider = provider;
  return result;
}

/** Set a Call's Usage and how it was served, and price it; replaces an earlier price and its issues. */
export function setUsage(call: Call, usage: Usage, raw?: JsonObject): void {
  call.usage = usage;
  const speed = str(raw?.speed);
  const tier = str(raw?.service_tier);
  const geo = str(raw?.inference_geo);
  if (speed) call.speed = speed;
  if (tier) call.serviceTier = tier;
  if (geo) call.inferenceGeo = geo;
  call.issues = call.issues.filter(
    (i) => i.kind !== "no-usage" && i.kind !== "no-price" && i.kind !== "price-assumption",
  );
  const { cost, issues } = priceCall(usage, {
    model: call.model,
    ...(call.speed === undefined ? {} : { speed: call.speed }),
    ...(call.inferenceGeo === undefined ? {} : { inferenceGeo: call.inferenceGeo }),
  });
  if (cost === undefined) delete call.cost;
  else call.cost = cost;
  call.issues.push(...issues);
}

/** Two usages are the same counts. */
export function sameUsage(a: Usage, b: Usage): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
