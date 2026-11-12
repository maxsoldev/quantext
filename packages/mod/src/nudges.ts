/** Rules for the nudges: toasts for the person alone, never added to the model's context. */
import type { TurnUsage } from "claude-code";
import type { Live } from "../types/index.js";
import { tokens, usd } from "./format.ts";
import { cacheWriteUsd } from "./prices.ts";

/** The prompt cache's default time to live: a longer idle gap may have let it expire. */
export const CACHE_TTL_MS = 5 * 60_000;
/** A re-write smaller than this is not worth a nudge. */
export const CACHE_REWRITE_NUDGE_TOKENS = 20_000;
/** Below this share of the last call's input read from the cache, the cache was lost rather than extended. */
export const CACHE_LOST_READ_SHARE = 0.5;
/** Context size at which every call gets expensive; nudged once until a compaction or /clear. */
export const CONTEXT_NUDGE_TOKENS = 200_000;

/** The expiry nudge for a main-loop call that started `startedAt`, or undefined when the cache held. */
export function cacheExpiryNudge(l: Live, u: TurnUsage, startedAt: number): string | undefined {
  if (l.lastEndAt === 0) return undefined;
  const idle = startedAt - l.lastEndAt;
  const rewrote = u.cache_creation_input_tokens;
  if (idle <= CACHE_TTL_MS || rewrote <= CACHE_REWRITE_NUDGE_TOKENS) return undefined;
  if (u.cache_read_input_tokens >= CACHE_LOST_READ_SHARE * l.lastCtx) return undefined;
  const cost = cacheWriteUsd(u.model, rewrote);
  const price = cost === undefined ? "" : ` (~${usd(cost)})`;
  return `quantext: cache expired after ${Math.round(idle / 60_000)} min idle; this call re-wrote ${tokens(rewrote)} tokens${price}.`;
}

/** The large-context nudge when `ctx` has reached the threshold and it was not shown since it was re-armed. */
export function contextNudge(l: Live, ctx: number): string | undefined {
  if (l.bigCtxNudged || ctx < CONTEXT_NUDGE_TOKENS) return undefined;
  return `quantext: context is ${tokens(ctx)} tokens. Consider /compact, /clear-tools or a new session.`;
}
