/**
 * The outputs half of `/clear-tools`: replace old tool outputs with the stub Claude Code's own microcompact
 * writes, and keep everything else, in place of a summary (`clear-tools.ts`).
 */
import type { SessionMessage } from "claude-code";

/** Claude Code's own stub for a cleared tool output. */
export const CLEARED = "[Old tool result content cleared]";

/** Tools whose results load deferred tool schemas (`tool_reference`): a stub would unload them. */
const KEEP_WHOLE = new Set(["ToolSearch"]);

/**
 * Stubs every tool result but the last `keep`. A message left whole keeps its engine handle; one changed loses
 * it, so the engine rebuilds it from its role, text and tool blocks. Stubs already there, and ToolSearch
 * results (kept whole), do not count.
 */
export function clearToolOutputs(messages: readonly SessionMessage[], keep = 0) {
  const keepWhole = new Set(
    messages.flatMap((m) => m.toolUses.filter((u) => KEEP_WHOLE.has(u.tool)).map((u) => u.tool_use_id)),
  );
  let left = keep;
  let cleared = 0;
  let chars = 0;
  const out = [...messages]
    .reverse()
    .map((m) => {
      const before = m.toolResults;
      if (before === undefined || before.length === 0) return m;
      const results = [...before]
        .reverse()
        .map((r) => {
          if (r.text === CLEARED || keepWhole.has(r.tool_use_id)) return r;
          if (left > 0) {
            left--;
            return r;
          }
          cleared++;
          chars += r.text.length;
          return { tool_use_id: r.tool_use_id, isError: r.isError, text: CLEARED };
        })
        .reverse();
      if (results.every((r, i) => r === before[i])) return m;
      const { handle: _, ...rest } = m;
      return { ...rest, toolResults: results };
    })
    .reverse();
  return { messages: out, cleared, chars };
}
