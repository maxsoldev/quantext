/** Map `api-request` rows and the `assistant` rows of their responses to Calls with exact Usage and cost. */
import type { Call, CallParams, Usage } from "@quantext/shared";
import { canonicalModel, priceUsage } from "../../core/pricing.ts";
import type { JsonObject } from "./json.ts";
import { arr, num, obj, str } from "./json.ts";
import type { Row } from "./rows.ts";

/** The Calls of one transcript, in log order. */
export function callsOf(rows: readonly Row[], sessionId: string): Call[] {
  const usageByRequest = responseUsage(rows);
  return rows
    .filter((row) => row.type === "api-request")
    .map((row, index) => {
      const id = str(row.data.id) ?? row.at;
      const params = obj(row.data.params) ?? {};
      const model = str(params.model) ?? "";
      const call: Call = { id, sessionId, index, ts: str(row.data.timestamp) ?? "", model, params: paramsOf(params) };
      const canonical = canonicalModel(model);
      if (canonical !== undefined) call.canonicalModel = canonical;
      const shapeHash = str(row.data.shapeHash);
      if (shapeHash !== undefined) call.shapeHash = shapeHash;
      const usage = usageByRequest.get(id);
      if (usage !== undefined) call.usage = usage;
      const cost = usage && canonical ? priceUsage(usage, canonical) : undefined;
      if (cost !== undefined) call.cost = cost;
      return call;
    });
}

/**
 * Usage per request id. One response is written as one `assistant` row per content block, each with the same
 * usage, so usage is taken once per `message.id`: from the last row of the last message of the request.
 */
function responseUsage(rows: readonly Row[]): Map<string, Usage> {
  const byRequest = new Map<string, Usage>();
  for (const row of rows) {
    if (row.type !== "assistant") continue;
    const ref = str(row.data.requestRef);
    const usage = obj(obj(row.data.message)?.usage);
    if (ref === undefined || usage === undefined) continue;
    byRequest.set(ref, usageOf(usage));
  }
  return byRequest;
}

function usageOf(raw: JsonObject): Usage {
  const usage: Usage = {
    basis: "exact",
    inputTokens: num(raw.input_tokens) ?? 0,
    cacheReadTokens: num(raw.cache_read_input_tokens) ?? 0,
    cacheWriteTokens: num(raw.cache_creation_input_tokens) ?? 0,
    outputTokens: num(raw.output_tokens) ?? 0,
  };
  const ttl = obj(raw.cache_creation);
  const write5m = num(ttl?.ephemeral_5m_input_tokens);
  const write1h = num(ttl?.ephemeral_1h_input_tokens);
  if (write5m !== undefined && write1h !== undefined) {
    usage.cacheWrite5mTokens = write5m;
    usage.cacheWrite1hTokens = write1h;
  }
  return usage;
}

function paramsOf(params: JsonObject): CallParams {
  const betas = [...(arr(params.betas) ?? []), ...(arr(params.anthropic_beta) ?? [])].filter(
    (beta): beta is string => typeof beta === "string",
  );
  const result: CallParams = { betas: [...new Set(betas)] };
  const maxTokens = num(params.max_tokens);
  if (maxTokens !== undefined) result.maxTokens = maxTokens;
  const thinking = obj(params.thinking);
  const thinkingType = str(thinking?.type);
  if (thinkingType !== undefined) {
    const budget = num(thinking?.budget_tokens);
    result.thinking = budget === undefined ? { type: thinkingType } : { type: thinkingType, budgetTokens: budget };
  }
  const effort = str(obj(params.output_config)?.effort);
  if (effort !== undefined) result.effort = effort;
  return result;
}
