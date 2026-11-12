/** Merge the Sessions that changed into the loaded list, in the engine's order (key desc, nulls last, log, id). */
import type { SessionSummary } from "@quantext/shared";
import type { SortKey } from "../route.ts";

const KEY: Record<SortKey, (s: SessionSummary) => string | number | undefined> = {
  ended: (s) => s.ended ?? s.started,
  started: (s) => s.started,
  cost: (s) => s.totals.all.cost.totalUsd,
  calls: (s) => s.calls,
};

export function mergeSessions(
  items: readonly SessionSummary[],
  changed: readonly SessionSummary[],
  sort: SortKey,
): SessionSummary[] {
  const id = (s: SessionSummary) => `${s.log}/${s.id}`;
  const fresh = new Map(changed.map((s) => [id(s), s]));
  const kept = items.filter((s) => !fresh.has(id(s)));
  const key = KEY[sort];
  const before = (a: SessionSummary, b: SessionSummary): number => {
    const x = key(a);
    const y = key(b);
    if (x !== y) {
      if (x === undefined || x === "") return 1;
      if (y === undefined || y === "") return -1;
      return x > y ? -1 : 1;
    }
    return a.log - b.log || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  };
  return [...kept, ...fresh.values()].sort(before);
}
