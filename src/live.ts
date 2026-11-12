/** The session's live figures, kept in `$.state`, and the footer label drawn from them. */
import type { EngineInterface, TurnUsage } from "claude-code";
import { atom, read, update } from "claude-code";
import type { Live } from "../types/index.js";
import { tokens, usd } from "./format.ts";

export const EMPTY: Live = { ctx: 0, read: 0, input: 0, lastEndAt: 0, lastCtx: 0, bigCtxNudged: false };
export const live = atom({ plugin: "quantext", key: "live" } as const, EMPTY);

// Function declarations: the mod's loader follows `$` across files only into those.
export function readLive($: EngineInterface): Promise<Live> {
  return read($, live);
}

export async function updateLive($: EngineInterface, fn: (l: Live) => Live): Promise<void> {
  await update($, live, fn);
}

/** All input tokens of one call: uncached, cache-written and cache-read. */
export const inputOf = (u: TurnUsage): number =>
  u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens;

/** `qx $14.46 · ctx 333k · cache 60%`; undefined before the first measurement. */
export function statusLabel(l: Live): string | undefined {
  if (l.ctx === 0) return undefined;
  const total = l.read + l.input;
  const parts = [
    ...(l.usd === undefined ? [] : [usd(l.usd)]),
    `ctx ${tokens(l.ctx)}`,
    ...(total > 0 ? [`cache ${Math.round((100 * l.read) / total)}%`] : []),
  ];
  return `qx ${parts.join(" · ")}`;
}
