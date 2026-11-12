/** A Session's cost with its subagents: the total, and the lines of its split for a tooltip. */
import type { SessionSummary, UnloggedEstimate } from "@quantext/shared";
import { count, usd } from "../format/format.ts";

/** A subagent's name: its agent name, its title, else the end of its id. */
export function subagentName(a: SessionSummary): string {
  return a.agentName ?? a.title ?? a.id.split(":").at(-1) ?? a.id;
}

/**
 * `total`: main and all subagents at any depth. `lines`: the main conversation, the subagents' count and sum, then
 * the `top` direct subagents by their own total (with theirs), and the rest in one line. No lines without subagents.
 */
export function costSplit(
  s: SessionSummary,
  subagents: readonly SessionSummary[],
  top = 5,
): { total: number; lines: string[] } {
  const t = s.totals;
  const total = t.all.cost.totalUsd;
  if (t.subagents.sessions === 0) return { total, lines: [] };
  const lines = [
    `Main conversation: ${usd(t.main.cost.totalUsd)}`,
    `${count(t.subagents.sessions, "subagent")} (all depths): ${usd(t.subagents.cost.totalUsd)}`,
  ];
  const ranked = [...subagents].sort((a, b) => b.totals.all.cost.totalUsd - a.totals.all.cost.totalUsd);
  if (ranked.length > 0) lines.push("Subagents, most expensive first:");
  for (const a of ranked.slice(0, top)) {
    const own = a.totals.subagents.sessions;
    const nested = own > 0 ? ` (with its ${count(own, "subagent")})` : "";
    lines.push(`· ${subagentName(a)}: ${usd(a.totals.all.cost.totalUsd)}${nested}`);
  }
  const rest = ranked.slice(top);
  if (rest.length > 0) {
    lines.push(`· and ${rest.length} more: ${usd(rest.reduce((n, a) => n + a.totals.all.cost.totalUsd, 0))}`);
  }
  return { total, lines };
}

/**
 * The note next to a Session's cost on the calls no transcript holds: a short label and its tooltip. "Up to",
 * because a transcript cannot show whether the summaries were turned off. None when nothing is estimated.
 */
export function unloggedNote(u: UnloggedEstimate): { label: string; tip: string } | undefined {
  if (u.calls === 0) return undefined;
  const cost = `~${usd(u.costUsd)}`;
  return {
    label: `plus up to ${cost} unlogged`,
    tip: [
      `Plus up to ${cost} of unlogged progress summaries (~${count(u.calls, "call")}) of ${count(u.subagents, "subagent")}.`,
      "An estimate, not in the exact cost: Claude Code bills these calls but writes them to no transcript. While a " +
        "subagent runs, every 30 s it sends the subagent's whole context again for a short summary; the estimate " +
        "counts the 30 s ticks with new rows and prices each as a cache read of the latest prompt.",
      ...(u.unpricedCalls > 0 ? [`${u.unpricedCalls} of them have no price and are not in the amount.`] : []),
      "It is $0 if CLAUDE_CODE_DISABLE_AGENT_PROGRESS_SUMMARIES=1 was set, which a transcript cannot show.",
    ].join("\n"),
  };
}
