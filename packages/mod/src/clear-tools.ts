/**
 * `/clear-tools [outputs] [keep N]`: stub old tool calls (inputs) and old tool outputs in one compaction, so the
 * prompt cache is written once; `outputs` stubs only the outputs. It runs as `/compact tools [outputs] keep N`,
 * which the mod's `session.compact` hook answers with no model call.
 */
import type { SessionMessage } from "claude-code";
import { clearToolCalls } from "./clear-tool-calls.ts";
import { clearToolOutputs } from "./clear-tool-outputs.ts";
import { tokens } from "./format.ts";

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

/** Clears what `a` asks for, keeping the last `a.keep` of each; `note` is the toast that says what it did. */
export function clearTools(messages: readonly SessionMessage[], a: ClearArgs) {
  const calls = a.outputsOnly ? undefined : clearToolCalls(messages, a.keep);
  const outputs = clearToolOutputs(calls?.messages ?? messages, a.keep);
  const parts = [...(calls ? [`${calls.cleared} tool calls`] : []), `${outputs.cleared} tool outputs`];
  const chars = (calls?.chars ?? 0) + outputs.chars;
  const kept = a.keep > 0 ? `, kept the last ${a.keep}` : "";
  return { messages: outputs.messages, note: `Cleared ${parts.join(" and ")} (~${tokens(chars / 4)} tokens)${kept}` };
}
