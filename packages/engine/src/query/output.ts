/** A Response's output split over its Blocks, and which earlier Response each Block of a context came from. */
import type { CallResponse, ContextBlock, ResponseEntry, TokenBasis } from "@quantext/shared";
import { reconcile } from "../core/attribute.ts";
import type { Estimate } from "../core/estimate.ts";

/** A weight only: characters per token, so text and reasoning with no logged text share one total fairly. */
const CHARS_PER_TOKEN = 3.3;

/**
 * Sets each entry's `tokens`, `basis` and `costUsd` from the Call's output. With a reported reasoning part, the
 * reasoning Blocks share it and the others the rest; reasoning with no text in the log takes what the text leaves.
 * Shares are by characters (basis `estimate`); an only Block takes all, with the Call's basis.
 */
export function splitOutput(
  entries: ResponseEntry[],
  output: { tokens: number; reasoningTokens?: number; usd?: number; basis: TokenBasis },
): void {
  if (entries.length === 0) return;
  const estimate = (e: ResponseEntry): Estimate =>
    e.kind === "reasoning" && e.reasoning !== undefined && e.reasoning !== "full"
      ? { tokens: 0, method: "unknown" }
      : { tokens: e.chars / CHARS_PER_TOKEN, method: "chars" };
  const shares = new Array<number>(entries.length).fill(0);
  const reasoning = output.reasoningTokens;
  const pools =
    reasoning === undefined || !entries.some((e) => e.kind === "reasoning")
      ? [{ pick: () => true, total: output.tokens }]
      : [
          { pick: (e: ResponseEntry) => e.kind === "reasoning", total: Math.min(reasoning, output.tokens) },
          { pick: (e: ResponseEntry) => e.kind !== "reasoning", total: Math.max(0, output.tokens - reasoning) },
        ];
  for (const pool of pools) {
    const at = entries.flatMap((e, i) => (pool.pick(e) ? [i] : []));
    const got = reconcile(
      at.map((i) => estimate(entries[i] as ResponseEntry)),
      pool.total,
    );
    at.forEach((i, k) => {
      shares[i] = got[k] ?? 0;
    });
  }
  entries.forEach((e, i) => {
    e.tokens = shares[i] ?? 0;
    e.basis = entries.length === 1 ? output.basis : "estimate";
    if (output.usd !== undefined) e.costUsd = output.tokens === 0 ? 0 : (output.usd * e.tokens) / output.tokens;
  });
}

/**
 * Marks each Block that is part of an earlier Call's Response with that Call: the latest one before the Block's
 * run began (or before `index`) whose Response holds the Block's hash.
 */
export function markResponses(
  blocks: ContextBlock[],
  responses: readonly { index: number; response: CallResponse }[],
  index: number,
): void {
  const by = new Map<string, number[]>();
  for (const r of responses) {
    for (const b of r.response.blocks) by.set(b.hash, [...(by.get(b.hash) ?? []), r.index]);
  }
  for (const b of blocks) {
    const calls = b.hash === undefined ? undefined : by.get(b.hash);
    if (calls === undefined) continue;
    const before = b.run?.firstCall ?? index;
    const from = Math.max(...calls.filter((c) => c < before));
    if (Number.isFinite(from)) b.fromResponseOf = from;
  }
}
