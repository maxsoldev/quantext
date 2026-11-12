/** Attribute each Call's input tokens to its Blocks with the core attribution, and build the CallBlocks. */
import type { Call, CallBlock } from "@quantext/shared";
import type { AttributionCall } from "../../core/attribute.ts";
import { attributeCalls } from "../../core/attribute.ts";
import type { Estimator } from "../../core/estimate.ts";
import { estimateRequest } from "../../core/estimate.ts";
import type { RequestBlock } from "./blocks.ts";
import type { WireRequest } from "./rebuild.ts";

export interface SplitCall {
  call: Call;
  request: WireRequest | undefined;
  entries: RequestBlock[];
}

/**
 * The CallBlocks of every Call, with tokens. Sets each Call's framing tokens and adds its attribution issues. A Call
 * whose request is incomplete is not attributed (its total stays, its Blocks get no tokens), and the next Call does
 * not carry tokens from it.
 */
export function attributeSession(calls: readonly SplitCall[], estimator?: Estimator): CallBlock[] {
  const inputs: AttributionCall[] = [];
  const lastByModel = new Map<string, string>();
  for (const { call, request, entries } of calls) {
    const previousId = request?.baseId ?? lastByModel.get(call.model);
    lastByModel.set(call.model, call.id);
    if (request === undefined || request.missing.length > 0) continue;
    const estimates = estimateRequest(
      entries.map((e) => e.block),
      estimator,
    );
    const input: AttributionCall = {
      id: call.id,
      model: call.model,
      blocks: entries.map((e, i) => ({
        hash: e.block.hash,
        estimate: estimates[i] ?? { tokens: 0, method: "unknown" },
        cacheBreakpoint: e.cacheBreakpoint,
      })),
    };
    if (previousId !== undefined) input.previousId = previousId;
    if (call.usage !== undefined) input.usage = call.usage;
    inputs.push(input);
  }
  const results = attributeCalls(inputs);
  return calls.flatMap(({ call, entries }) => {
    const result = results.get(call.id);
    if (result !== undefined) {
      call.framingTokens = result.framingTokens;
      call.issues.push(...result.issues);
    }
    return entries.map((entry, position) => {
      const callBlock: CallBlock = {
        callId: call.id,
        blockHash: entry.block.hash,
        position,
        section: entry.section,
        cacheBreakpoint: entry.cacheBreakpoint,
        inCachedPrefix: result?.blocks?.[position]?.inCachedPrefix ?? false,
      };
      if (entry.message !== undefined) callBlock.message = entry.message;
      const tokens = result?.blocks?.[position];
      if (tokens !== undefined) Object.assign(callBlock, { tokens: tokens.tokens, basis: tokens.basis });
      return callBlock;
    });
  });
}
