/**
 * `/clear-tools [outputs] [keep N]`: stub old tool calls (inputs) and old tool outputs in one compaction, so the
 * prompt cache is written once; `outputs` stubs only the outputs. It runs as `/compact tools [outputs] keep N`,
 * which the mod's `session.compact` hook answers with no model call.
 */
import type { SessionMessage } from "claude-code";
import type { Live } from "../types/index.js";
import { clearToolCalls } from "./clear-tool-calls.ts";
import { clearToolOutputs } from "./clear-tool-outputs.ts";
import { approx, grouped, tokens, usd } from "./format.ts";
import { CACHE_READ, CACHE_WRITE_1H, CACHE_WRITE_5M, cacheWriteUsd } from "./prices.ts";

export const USAGE = "Usage: /clear-tools [outputs] [keep N]";

/** What to clear: only outputs, or calls and outputs; `keep` is how many of the last ones stay whole. */
export type ClearArgs = { outputsOnly: boolean; keep: number };

/** Reads `[outputs] [keep N]` (`keep` may be left out before N); a reason when the words are something else. */
export function parseClearArgs(args: string): ClearArgs | { error: string } {
  const words = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const outputsOnly = words[0] === "outputs";
  const rest = outputsOnly ? words.slice(1) : words;
  const hasKeep = rest[0] === "keep";
  const n = hasKeep ? rest[1] : rest[0];
  const extra = rest[hasKeep ? 2 : 1];
  if (n !== undefined && !/^\d+$/.test(n))
    return { error: hasKeep ? `keep needs a whole number, not "${n}"` : `unknown word "${n}"` };
  if (hasKeep && n === undefined) return { error: "keep needs a whole number" };
  if (extra !== undefined) return { error: `unknown word "${extra}"` };
  return { outputsOnly, keep: Number(n ?? 0) };
}

/** The `/compact` arguments that run `a`. */
export const compactArgs = (a: ClearArgs): string => `tools ${a.outputsOnly ? "outputs " : ""}keep ${a.keep}`;

/** What `a` clears, in words. */
export const clearWhat = (a: Pick<ClearArgs, "outputsOnly">): string =>
  a.outputsOnly ? "tool outputs" : "tool calls and outputs";

/** The request in `/compact tools [outputs] [keep N]`; undefined for any other compaction. */
export function clearRequest(instructions: string | undefined): ClearArgs | undefined {
  const asked = /^\s*tools\b(.*)$/is.exec(instructions ?? "");
  const a = asked ? parseClearArgs(asked[1] ?? "") : undefined;
  return a && !("error" in a) ? a : undefined;
}

const count = (n: number, what: string): string => `${n} ${what}${n === 1 ? "" : "s"}`;

/**
 * What the clear costs: the next call writes the whole new context to the cache again (estimated from the last
 * call's input less the tokens removed), and each later call reads `saved` fewer tokens. The payback is that
 * write's extra over a read, over the per-call read saving; the TTL is not known, so both are given.
 */
function costNote(saved: number, l: Pick<Live, "lastCtx" | "model">): string {
  if (l.lastCtx === 0) return " The cache re-write cost shows once a call is measured.";
  const rewrite = Math.max(0, l.lastCtx - saved);
  const usd5 = l.model === undefined ? undefined : cacheWriteUsd(l.model, rewrite);
  const usd1 = l.model === undefined ? undefined : cacheWriteUsd(l.model, rewrite, CACHE_WRITE_1H);
  const price =
    usd5 === undefined || usd1 === undefined ? "" : ` (~${usd(usd5)} with the 5-min cache, ~${usd(usd1)} with 1 h)`;
  const payback = (write: number) => Math.ceil((rewrite * (write - CACHE_READ)) / (saved * CACHE_READ));
  const back =
    saved > 0
      ? `; it pays back after ~${payback(CACHE_WRITE_5M)} calls (5 min) or ~${payback(CACHE_WRITE_1H)} (1 h)`
      : "";
  return ` The next call re-writes ~${tokens(rewrite)} tokens to the cache once${price}${back}.`;
}

/**
 * Clears what `a` asks for, keeping the last `a.keep` of each; `note` is the toast that says what it did and what
 * it costs (from `l`, the live figures). A clear that would change nothing is a `skip`: no compaction at all.
 */
export function clearTools(
  messages: readonly SessionMessage[],
  a: ClearArgs,
  l: Pick<Live, "lastCtx" | "model">,
): { messages: SessionMessage[]; note: string } | { skip: string } {
  const calls = a.outputsOnly ? undefined : clearToolCalls(messages, a.keep);
  const outputs = clearToolOutputs(calls?.messages ?? messages, a.keep);
  if ((calls?.cleared ?? 0) + outputs.cleared === 0) return { skip: "quantext: nothing to clear" };
  const parts = [...(calls ? [count(calls.cleared, "tool call")] : []), count(outputs.cleared, "tool output")];
  const chars = (calls?.chars ?? 0) + outputs.chars;
  const kept = a.keep > 0 ? `, kept the last ${a.keep}` : "";
  const done = `Cleared ${parts.join(" and ")}${kept}: ${grouped(chars)} chars less (~${approx(chars)} tokens).`;
  return { messages: outputs.messages, note: done + costNote(Math.round(chars / 4), l) };
}
