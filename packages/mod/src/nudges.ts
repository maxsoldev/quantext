/** Rules for the nudges: toasts for the person alone, never added to the model's context. */
import type { TurnUsage } from "claude-code";
import type { Live } from "../types/index.js";
import { tokens, usd } from "./format.ts";
import { CACHE_WRITE_1H, CACHE_WRITE_5M, cacheWriteUsd } from "./prices.ts";

/** The prompt cache's two lifetimes: 5 minutes by default, 1 hour when the harness asks for it. */
export const CACHE_TTL_MS = 5 * 60_000;
export const CACHE_TTL_1H_MS = 60 * 60_000;
/** A re-write smaller than this is not worth a nudge. */
export const CACHE_REWRITE_NUDGE_TOKENS = 20_000;
/** Below this share of the last call's input read from the cache, the cache was lost rather than extended. */
export const CACHE_LOST_READ_SHARE = 0.5;
/** Context size at which every call gets expensive; nudged once until a compaction or /clear. */
export const CONTEXT_NUDGE_TOKENS = 200_000;

const CHANGED = "the start of the request changed (tools, MCP servers, CLAUDE.md?)";
const SEE = " /quantext view shows the first change.";

/** Whether a main-loop call read most of the last call's input from the cache. */
export const cacheHeld = (l: Live, u: TurnUsage): boolean =>
  u.cache_read_input_tokens >= CACHE_LOST_READ_SHARE * l.lastCtx;

/**
 * Why a main-loop call that started `startedAt` lost the cache, or undefined when it held. The reason, first that
 * fits (as the engine's cache breaks): a compaction, a model switch, a pause past the cache's lifetime, else a
 * change early in the request. The lifetime is known to be 1 hour once the cache held over a longer pause.
 */
export function cacheBreakNudge(l: Live, u: TurnUsage, startedAt: number): string | undefined {
  if (l.lastEndAt === 0) return undefined;
  const rewrote = u.cache_creation_input_tokens;
  if (rewrote <= CACHE_REWRITE_NUDGE_TOKENS || cacheHeld(l, u)) return undefined;
  const cost = cacheWriteUsd(u.model, rewrote, l.hourCache ? CACHE_WRITE_1H : CACHE_WRITE_5M);
  const w = `${tokens(rewrote)} tokens${cost === undefined ? "" : ` (~${usd(cost)})`}`;
  const idle = startedAt - l.lastEndAt;
  const min = Math.round(idle / 60_000);
  if (l.compacted) return `quantext: cache re-written after a compaction, as expected; this call wrote ${w}.`;
  if (l.model !== undefined && l.model !== u.model) {
    const from = `a switch from ${l.model} to ${u.model} (each model has its own cache)`;
    return `quantext: cache re-written after ${from}; this call wrote ${w}.`;
  }
  if (idle > CACHE_TTL_1H_MS) return `quantext: cache expired after ${min} min idle; this call re-wrote ${w}.`;
  if (idle <= CACHE_TTL_MS) {
    return `quantext: cache lost after ${min} min, with no compaction or model switch: ${CHANGED}; this call re-wrote ${w}.${SEE}`;
  }
  if (l.hourCache) {
    return `quantext: cache lost after ${min} min idle, within its 1-hour lifetime: ${CHANGED}; this call re-wrote ${w}.${SEE}`;
  }
  const both = "it expired if it lives 5 min, else the start of the request changed";
  return `quantext: cache lost after ${min} min idle: ${both}; this call re-wrote ${w}.`;
}

/** The large-context nudge when `ctx` has reached the threshold and it was not shown since it was re-armed. */
export function contextNudge(l: Live, ctx: number): string | undefined {
  if (l.bigCtxNudged || ctx < CONTEXT_NUDGE_TOKENS) return undefined;
  return `quantext: context is ${tokens(ctx)} tokens. Consider /compact, /clear-tools or a new session.`;
}
