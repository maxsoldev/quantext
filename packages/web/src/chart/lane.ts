/** One lane of a Session's timeline: its Calls in order, and the markers placed by a Call's place in the lane. */
import type { CacheBreak, LaneSummary, TimelineCall } from "@quantext/shared";

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
