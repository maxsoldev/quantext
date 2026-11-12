/** Windowed lists: of `count` rows of a fixed height, the ones a scroll position shows, plus `overscan` each side. */
export interface Window {
  start: number;
  /** One past the last row drawn. */
  end: number;
  /** Pixels above and below the drawn rows. */
  before: number;
  after: number;
}

export function windowOf(o: {
  scrollTop: number;
  height: number;
  rowHeight: number;
  count: number;
  overscan: number;
}): Window {
  const first = Math.floor(o.scrollTop / o.rowHeight);
  const start = Math.max(0, Math.min(first, o.count) - o.overscan);
  const end = Math.min(o.count, Math.ceil((o.scrollTop + o.height) / o.rowHeight) + o.overscan);
  const s = Math.min(start, end);
  return { start: s, end, before: s * o.rowHeight, after: (o.count - end) * o.rowHeight };
}
