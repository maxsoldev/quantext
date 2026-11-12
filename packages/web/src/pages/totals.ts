/** A Session's cost with its subagents: the total, and the lines of its split for a tooltip. */
import type { SessionSummary } from "@quantext/shared";
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
    lines.push(`  ${subagentName(a)}: ${usd(a.totals.all.cost.totalUsd)}${nested}`);
  }
  const rest = ranked.slice(top);
  if (rest.length > 0) {
    lines.push(`  and ${rest.length} more: ${usd(rest.reduce((n, a) => n + a.totals.all.cost.totalUsd, 0))}`);
  }
  return { total, lines };
}
