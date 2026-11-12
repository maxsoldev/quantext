/**
 * The three clear commands: `/clear-tool-outputs`, `/clear-tool-calls` and `/clear-tools` (both in one
 * compaction, so the prompt cache is written once, not twice). Each runs as `/compact <kind> keep N`, which the
 * mod's `session.compact` hook answers with no model call.
 */
import type { SessionMessage } from "claude-code";
import { clearToolCalls } from "./clear-tool-calls.ts";
import { clearToolOutputs } from "./clear-tool-outputs.ts";
import { tokens } from "./format.ts";

export type ClearKind = "tool-outputs" | "tool-calls" | "tools";

/** Each command: its name, the `/compact` word it queues, and the words for what it clears. */
export const CLEAR_COMMANDS = [
  { name: "clear-tool-outputs", kind: "tool-outputs", what: "tool outputs" },
  { name: "clear-tool-calls", kind: "tool-calls", what: "tool calls" },
  { name: "clear-tools", kind: "tools", what: "tool calls and outputs" },
] as const satisfies readonly { name: string; kind: ClearKind; what: string }[];

/** Reads `keep N`, `N` or nothing (keep 0); undefined when the text is something else. */
export function parseKeep(args: string): number | undefined {
  const m = /^\s*(?:keep\s+)?(\d+)?\s*$/i.exec(args);
  return m ? Number(m[1] ?? 0) : undefined;
}

/** The kind and N of `/compact <kind> [keep N]`; undefined for any other compaction. */
export function clearRequest(instructions: string | undefined): { kind: ClearKind; keep: number } | undefined {
  const asked = /^\s*(tool-outputs|tool-calls|tools)\b(.*)$/is.exec(instructions ?? "");
  const keep = asked ? parseKeep(asked[2] ?? "") : undefined;
  return asked && keep !== undefined ? { kind: asked[1]?.toLowerCase() as ClearKind, keep } : undefined;
}

/** Clears what `kind` names, keeping the last `keep` of each; `note` is the toast that says what it did. */
export function clearTools(messages: readonly SessionMessage[], kind: ClearKind, keep: number) {
  const calls = kind === "tool-outputs" ? undefined : clearToolCalls(messages, keep);
  const outputs = kind === "tool-calls" ? undefined : clearToolOutputs(calls?.messages ?? messages, keep);
  const parts = [
    ...(calls ? [`${calls.cleared} tool calls`] : []),
    ...(outputs ? [`${outputs.cleared} tool outputs`] : []),
  ];
  const chars = (calls?.chars ?? 0) + (outputs?.chars ?? 0);
  const kept = keep > 0 ? `, kept the last ${keep}` : "";
  return {
    messages: outputs?.messages ?? calls?.messages ?? messages,
    note: `Cleared ${parts.join(" and ")} (~${tokens(chars / 4)} tokens)${kept}`,
  };
}
