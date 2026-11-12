/** One lane of a Session's timeline: its Calls in order, and the markers placed by a Call's place in the lane. */
import type { CacheBreak, LaneSummary, TimelineCall } from "@quantext/shared";
import { shortModel } from "../format/format.ts";

export interface LaneView {
  lane: string;
  calls: TimelineCall[];
  /** The place in the lane of the Call with this index, if it is in the lane. */
  at(index: number): number | undefined;
  /** The place of the lane's last Call at or before this index (the first Call when none is). */
  nearest(index: number): number;
  /** Compactions, at the lane's first Call after each. */
  compactions: { at: number; index: number }[];
  breaks: (CacheBreak & { at: number })[];
}

/** The lane with the most Calls: the main loop. */
export function mainLane(lanes: readonly LaneSummary[]): string | undefined {
  return [...lanes].sort((a, b) => b.calls - a.calls)[0]?.lane;
}

/** The harness's query sources of the main loop: interactive, and `claude -p` / the Agent SDK. */
const MAIN_SOURCES = new Set(["repl_main_thread", "sdk"]);

/** A lane's job, from its key (`<model>|<query source>`, or `compaction` for the summarising Calls). */
function jobOf(l: LaneSummary, main: string | undefined): string {
  if (l.lane === "compaction") return "Compaction summary";
  const source = l.lane.slice(l.lane.lastIndexOf("|") + 1);
  if (MAIN_SOURCES.has(source) || l.lane === main) return "Main";
  if (source === "compact") return "Compaction summary";
  const agent = /^agent:(?:[^:]*:)?(.+)$/.exec(source)?.[1];
  if (agent) return `Subagent ${agent}`;
  if (source === "") return "Side calls";
  const words = source.replace(/[_-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Lane key → its name in the UI, by job; a name two lanes share gets each lane's model. */
export function laneNames(lanes: readonly LaneSummary[]): Map<string, string> {
  const main = mainLane(lanes);
  const jobs = lanes.map((l) => [l, jobOf(l, main)] as const);
  const seen = new Map<string, number>();
  for (const [, job] of jobs) seen.set(job, (seen.get(job) ?? 0) + 1);
  return new Map(
    jobs.map(([l, job]) => [
      l.lane,
      (seen.get(job) ?? 0) > 1 ? `${job} (${l.model ? shortModel(l.model) : "unknown model"})` : job,
    ]),
  );
}

export function laneView(timeline: readonly TimelineCall[], breaks: readonly CacheBreak[], lane: string): LaneView {
  const calls = timeline.filter((c) => c.lane === lane).sort((a, b) => a.index - b.index);
  const place = new Map(calls.map((c, i) => [c.index, i]));
  const nearest = (index: number) => {
    let lo = 0;
    let hi = calls.length - 1;
    let found = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if ((calls[mid]?.index ?? 0) <= index) {
        found = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return found;
  };
  return {
    lane,
    calls,
    at: (index) => place.get(index),
    nearest,
    compactions: calls.flatMap((c, i) => (c.compaction === "after" ? [{ at: i, index: c.index }] : [])),
    breaks: breaks.flatMap((b) => {
      const at = b.lane === lane ? place.get(b.index) : undefined;
      return at === undefined ? [] : [{ ...b, at }];
    }),
  };
}
