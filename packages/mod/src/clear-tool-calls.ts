/**
 * The calls half of `/clear-tools`: replace the input of old tool calls with a short stub, so the model's own
 * Write contents, Bash heredocs and Agent briefs leave the context. Each call keeps its name and id, so it still
 * pairs with its result. Deterministic: no model call (`clear-tools.ts`).
 */
import type { SessionMessage, ToolUseSummary } from "claude-code";
import { tokens } from "./format.ts";

/** Starts every stub, so a second run sees which inputs are cleared already. */
export const CLEARED_INPUT = "[Old tool input cleared";

/** Inputs up to this size (~200 tokens) stay: a stub would save little. */
const SMALL_INPUT_CHARS = 800;
/** A field up to this size stays in the stub input (a path, a name, a short description). */
const SMALL_FIELD_CHARS = 200;
const HEAD_CHARS = 60;

const sizeOf = (v: unknown): number => JSON.stringify(v)?.length ?? 0;
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const lineCount = (s: string): number => (s === "" ? 0 : s.split("\n").length);
/** Tokens at ~4 characters each: `850`, `4.2k`, `12k`. */
const approx = (chars: number): string => {
  const n = Math.round(chars / 4);
  return n < 1000 ? `${n}` : n < 10_000 ? `${(n / 1000).toFixed(1)}k` : tokens(n);
};
const head = (s: string): string => {
  const first = s.split("\n")[0] ?? "";
  return first.slice(0, HEAD_CHARS);
};

/** The stub's words, from the tool name and its key fields, with the size the input had. */
export function describeCall(tool: string, input: Record<string, unknown>): string {
  const size = `${approx(sizeOf(input))} tokens`;
  switch (tool) {
    case "Write":
      return `Write ${str(input.file_path)} (${size})`;
    case "Edit":
      return `Edit ${str(input.file_path)} (${lineCount(str(input.new_string))} lines)`;
    case "Bash": {
      const cmd = str(input.command);
      const n = lineCount(cmd);
      return `Bash: ${head(cmd)} … (${n > 1 ? `1 of ${n} lines` : size})`;
    }
    case "Agent":
    case "Task": {
      const what = str(input.description) || head(str(input.prompt));
      return `${tool} (${str(input.subagent_type) || "general-purpose"}): "${what}" (${size})`;
    }
    case "SendMessage":
      return `SendMessage to ${str(input.to) || "?"} (${size})`;
    default:
      return `${tool} (${size})`;
  }
}

/**
 * The input with each big field emptied (same JSON type, so the harness can still draw the call) and the stub
 * in its biggest string field, or under `_cleared` when it has none. Small fields stay as they were.
 */
function stubInput(tool: string, input: Record<string, unknown>): Record<string, unknown> {
  const stub = `${CLEARED_INPUT}: ${describeCall(tool, input)}]`;
  const big = Object.entries(input).filter(([, v]) => sizeOf(v) > SMALL_FIELD_CHARS);
  const main = big.filter(([, v]) => typeof v === "string").sort(([, a], [, b]) => sizeOf(b) - sizeOf(a))[0]?.[0];
  const out: Record<string, unknown> = { ...input };
  for (const [k, v] of big) out[k] = typeof v === "string" ? "" : Array.isArray(v) ? [] : {};
  if (main === undefined) out._cleared = stub;
  else out[main] = stub;
  return out;
}

const isStub = (u: ToolUseSummary): boolean =>
  Object.values(u.input).some((v) => typeof v === "string" && v.startsWith(CLEARED_INPUT));

/**
 * Stubs the input of every tool call but the last `keep`; small inputs stay. A changed message loses its engine
 * handle and is rebuilt from role, text and tool blocks. Calls stubbed already do not count toward `keep`.
 */
export function clearToolCalls(messages: readonly SessionMessage[], keep = 0) {
  let left = keep;
  let cleared = 0;
  let chars = 0;
  const out = [...messages]
    .reverse()
    .map((m) => {
      const before = m.toolUses;
      if (before.length === 0) return m;
      const uses = [...before]
        .reverse()
        .map((u) => {
          if (isStub(u)) return u;
          if (left > 0) {
            left--;
            return u;
          }
          const size = sizeOf(u.input);
          if (size <= SMALL_INPUT_CHARS) return u;
          const input = stubInput(u.tool, u.input);
          cleared++;
          chars += size - sizeOf(input);
          return { ...u, input };
        })
        .reverse();
      if (uses.every((u, i) => u === before[i])) return m;
      const { handle: _, ...rest } = m;
      return { ...rest, toolUses: uses };
    })
    .reverse();
  return { messages: out, cleared, chars };
}
