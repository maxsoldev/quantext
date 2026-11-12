/** Chart data shaping, no DOM: stacks of a Call's parts, axis ticks, the band per Call, step-area paths. */

export type Span = [number, number];

export interface Stack<K extends string> {
  series: { key: K; spans: Span[] }[];
  /** Per row, the top of the stack. */
  totals: number[];
  max: number;
}

/** Stack each row's parts in `keys` order: a part's span starts where the one before it ended. */
export function stack<R, K extends string>(
  rows: readonly R[],
  keys: readonly K[],
  value: (row: R, key: K) => number,
): Stack<K> {
  const base = rows.map(() => 0);
  const series = keys.map((key) => ({
    key,
    spans: rows.map((row, i): Span => {
      const lo = base[i] ?? 0;
      const hi = lo + Math.max(0, value(row, key));
      base[i] = hi;
      return [lo, hi];
    }),
  }));
  return { series, totals: base, max: Math.max(0, ...base) };
}

/** Ticks from 0 in steps of 1, 2 or 5 × 10ⁿ, about `count` of them, the last at or above `max`. */
export function niceTicks(max: number, count: number): number[] {
  if (max <= 0) return [0, 1];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = ([1, 2, 5, 10].find((m) => m * mag >= raw) ?? 10) * mag;
  const ticks: number[] = [];
  for (let v = 0; v < max + step; v += step) {
    ticks.push(v);
    if (v >= max) break;
  }
  return ticks;
}

export interface Band {
  /** Pixels per Call. */
  step: number;
  /** The drawn width of one Call's column (≤ 24px, with a 2px gap), or the step in area mode. */
  width: number;
  mode: "columns" | "area";
}

/** Columns while a Call gets at least 6px (4px mark and a 2px gap), else a stacked area. */
export function bandOf(width: number, count: number): Band {
  const step = width / Math.max(1, count);
  if (step < 6) return { step, width: step, mode: "area" };
  return { step, width: Math.min(24, step - 2), mode: "columns" };
}

/** A closed path of steps: across each row at its upper value, back along the lower values. */
export function stepArea(
  spans: readonly Span[],
  x: (i: number) => number,
  step: number,
  y: (v: number) => number,
): string {
  if (spans.length === 0) return "";
  const r = (n: number) => Math.round(n * 100) / 100;
  let d = `M${r(x(0))},${r(y(spans[0]?.[1] ?? 0))}`;
  spans.forEach(([, hi], i) => {
    if (i > 0) d += `V${r(y(hi))}`;
    d += `H${r(x(i) + step)}`;
  });
  for (let i = spans.length - 1; i >= 0; i--) {
    d += `V${r(y(spans[i]?.[0] ?? 0))}`;
    d += `H${r(x(i))}`;
  }
  return `${d}Z`;
}
