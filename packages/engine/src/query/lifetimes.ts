/**
 * The lifetime cost of a Session's Blocks in O((calls + runs) · log calls), the same numbers as `lifetimeSql`
 * (views.ts), which joins every run with every Call it covers and so grows with their product.
 *
 * A run at position p with T tokens over the Calls [a, b] of its lane costs, per Call c:
 * - p < boundary(c): T at c's cache-read price (in the Cached prefix);
 * - p > boundary(c): T at c's write price (or input, when c wrote no cache): `rest` = T;
 * - p = boundary(c): the part beyond c's cache read, at the write price. Only one run of a lane covers a Call at
 *   one position, so these pairs are at most one per Call: each is found directly.
 * The first case is all Calls priced as read (prefix sums over the lane), less the rest. The second is a sum over
 * the Calls in [a, b] whose boundary is below p: runs are taken by position, and Calls are added to Fenwick trees
 * (by their place in the lane) once their boundary is below the current position: one range query per run.
 */
import type { SqlValue } from "../store/index.ts";

/** A Call of the Session, as the store keeps what pricing needs (`calls_lane`). */
export interface PricedCall {
  lane: string;
  idx: number;
  /** The position of the Block at the cache boundary; null when the Call has none. */
  boundary: number | null;
  /** Tokens before the Block at the boundary. */
  offset: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  /** US dollars per cache-read token, and per written (or plain input) token. */
  unitRead: number | null;
  unitRest: number | null;
}

/** A CallBlock run of the Session. */
export interface PricedRun {
  lane: string;
  firstCall: number;
  /** Null: open, on to the lane's latest Call. */
  lastCall: number | null;
  position: number;
  tokens: number | null;
  blockHash: string;
}

/** One Block's lifetime, as `lifetimeSql` gives its columns (tokens null when no run has tokens). */
export interface LifetimeRow {
  block_hash: string;
  runs: number;
  calls: number;
  tokens: number | null;
  lifetime_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  input_tokens: number;
  cost_cache_read_usd: number;
  cost_cache_write_usd: number;
  cost_input_usd: number;
  lifetime_cost_usd: number;
}

/** The per-Call parts summed over the Calls where a run lies after the boundary (each times T). */
const PARTS = 5; // count, unit read, unit rest, count with a cache write, unit rest with a cache write

/** A Fenwick tree of `PARTS` sums over the places 0..n-1 of a lane. */
class Fenwick {
  readonly #sums: Float64Array;
  readonly #n: number;
  constructor(n: number) {
    this.#n = n;
    this.#sums = new Float64Array((n + 1) * PARTS);
  }
  add(place: number, values: readonly number[]): void {
    for (let i = place + 1; i <= this.#n; i += i & -i) {
      for (let k = 0; k < PARTS; k++) this.#sums[i * PARTS + k] = (this.#sums[i * PARTS + k] ?? 0) + (values[k] ?? 0);
    }
  }
  /** The sums over places [0, end). */
  prefix(end: number, out: Float64Array): void {
    out.fill(0);
    for (let i = end; i > 0; i -= i & -i) {
      for (let k = 0; k < PARTS; k++) out[k] = (out[k] ?? 0) + (this.#sums[i * PARTS + k] ?? 0);
    }
  }
}

/** The first place in sorted `xs` whose value is at least `x`. */
function lowerBound(xs: readonly number[], x: number): number {
  let lo = 0;
  let hi = xs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((xs[mid] ?? 0) < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

interface RunSums {
  calls: number;
  unitRead: number;
  rest: number;
  restRead: number;
  restUsd: number;
  wr: number;
  wrUsd: number;
}

/** Each Block's lifetime over the Session's runs and Calls. */
export function lifetimes(calls: readonly PricedCall[], runs: readonly PricedRun[]): Map<string, LifetimeRow> {
  const lanes = new Map<string, PricedCall[]>();
  for (const c of calls) {
    const lane = lanes.get(c.lane) ?? [];
    lane.push(c);
    lanes.set(c.lane, lane);
  }
  const sums = new Map<PricedRun, RunSums>();
  const runsByLane = new Map<string, PricedRun[]>();
  for (const r of runs) {
    const list = runsByLane.get(r.lane) ?? [];
    list.push(r);
    runsByLane.set(r.lane, list);
  }
  for (const [laneName, laneRuns] of runsByLane) {
    const laneCalls = (lanes.get(laneName) ?? []).slice().sort((x, y) => x.idx - y.idx);
    const idxs = laneCalls.map((c) => c.idx);
    // Prefix sums of the count and of the cache-read price, over all Calls of the lane.
    const readPrefix = new Float64Array(laneCalls.length + 1);
    laneCalls.forEach((c, i) => {
      readPrefix[i + 1] = (readPrefix[i] ?? 0) + (c.unitRead ?? 0);
    });
    /** The places [from, to) of the Calls in the run's range. */
    const span = (r: PricedRun): [number, number] => [
      lowerBound(idxs, r.firstCall),
      r.lastCall === null ? idxs.length : lowerBound(idxs, r.lastCall + 1),
    ];
    for (const r of laneRuns) {
      const [from, to] = span(r);
      sums.set(r, {
        calls: to - from,
        unitRead: (readPrefix[to] ?? 0) - (readPrefix[from] ?? 0),
        rest: 0,
        restRead: 0,
        restUsd: 0,
        wr: 0,
        wrUsd: 0,
      });
    }
    // After the boundary: sweep runs by position, adding Calls whose boundary is below it.
    const bounded = laneCalls
      .map((c, place) => ({ c, place }))
      .filter((x) => x.c.boundary !== null)
      .sort((x, y) => (x.c.boundary ?? 0) - (y.c.boundary ?? 0));
    const tree = new Fenwick(laneCalls.length);
    const hi = new Float64Array(PARTS);
    const lo = new Float64Array(PARTS);
    let next = 0;
    for (const r of [...laneRuns].sort((x, y) => x.position - y.position)) {
      while (next < bounded.length && (bounded[next]?.c.boundary ?? 0) < r.position) {
        const { c, place } = bounded[next] as { c: PricedCall; place: number };
        const wrote = (c.cacheWrite ?? 0) > 0;
        tree.add(place, [1, c.unitRead ?? 0, c.unitRest ?? 0, wrote ? 1 : 0, wrote ? (c.unitRest ?? 0) : 0]);
        next++;
      }
      if (r.tokens === null) continue; // no tokens: every part is null in SQL, so it adds nothing
      const [from, to] = span(r);
      tree.prefix(to, hi);
      tree.prefix(from, lo);
      const s = sums.get(r) as RunSums;
      const t = r.tokens;
      s.rest += t * ((hi[0] ?? 0) - (lo[0] ?? 0));
      s.restRead += t * ((hi[1] ?? 0) - (lo[1] ?? 0));
      s.restUsd += t * ((hi[2] ?? 0) - (lo[2] ?? 0));
      s.wr += t * ((hi[3] ?? 0) - (lo[3] ?? 0));
      s.wrUsd += t * ((hi[4] ?? 0) - (lo[4] ?? 0));
    }
    // At the boundary: the run at the boundary's position that covers the Call, if any.
    const atPosition = new Map<number, PricedRun[]>();
    for (const r of laneRuns) {
      const list = atPosition.get(r.position) ?? [];
      list.push(r);
      atPosition.set(r.position, list);
    }
    for (const list of atPosition.values()) list.sort((x, y) => x.firstCall - y.firstCall);
    for (const c of laneCalls) {
      if (c.boundary === null || c.offset === null || c.cacheRead === null) continue;
      const list = atPosition.get(c.boundary);
      if (list === undefined) continue;
      const firsts = list.map((r) => r.firstCall);
      const r = list[lowerBound(firsts, c.idx + 1) - 1];
      if (r === undefined || r.tokens === null || (r.lastCall !== null && r.lastCall < c.idx)) continue;
      const rest = r.tokens - Math.min(r.tokens, Math.max(0, c.cacheRead - c.offset));
      const s = sums.get(r) as RunSums;
      s.rest += rest;
      s.restRead += rest * (c.unitRead ?? 0);
      s.restUsd += rest * (c.unitRest ?? 0);
      if ((c.cacheWrite ?? 0) > 0) {
        s.wr += rest;
        s.wrUsd += rest * (c.unitRest ?? 0);
      }
    }
  }
  const out = new Map<string, LifetimeRow>();
  for (const [r, s] of sums) {
    const t = r.tokens ?? 0;
    const row = out.get(r.blockHash) ?? {
      block_hash: r.blockHash,
      runs: 0,
      calls: 0,
      tokens: null,
      lifetime_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      input_tokens: 0,
      cost_cache_read_usd: 0,
      cost_cache_write_usd: 0,
      cost_input_usd: 0,
      lifetime_cost_usd: 0,
    };
    row.runs++;
    row.calls += s.calls;
    if (r.tokens !== null) row.tokens = Math.max(row.tokens ?? r.tokens, r.tokens);
    row.lifetime_tokens += t * s.calls;
    row.cache_read_tokens += t * s.calls - s.rest;
    row.cache_write_tokens += s.wr;
    row.input_tokens += s.rest - s.wr;
    const readUsd = t * s.unitRead - s.restRead;
    row.cost_cache_read_usd += readUsd;
    row.cost_cache_write_usd += s.wrUsd;
    row.cost_input_usd += s.restUsd - s.wrUsd;
    row.lifetime_cost_usd += readUsd + s.restUsd;
    out.set(r.blockHash, row);
  }
  return out;
}

/** The Session's Calls and runs as the store keeps them, for `lifetimes`. */
export const PRICED_CALLS = `SELECT lane, idx, cache_boundary_position, cache_boundary_offset, cache_read_tokens,
  cache_write_tokens, unit_read_usd, unit_rest_usd FROM calls WHERE log = ? AND session_id = ?`;
export const PRICED_RUNS = `SELECT lane, first_call, last_call, position, tokens, block_hash FROM call_blocks
  WHERE log = ? AND session_id = ?`;

const num = (v: SqlValue | undefined): number | null => (v === null || v === undefined ? null : Number(v));

export function pricedCall(r: Record<string, SqlValue>): PricedCall {
  return {
    lane: String(r.lane),
    idx: Number(r.idx),
    boundary: num(r.cache_boundary_position),
    offset: num(r.cache_boundary_offset),
    cacheRead: num(r.cache_read_tokens),
    cacheWrite: num(r.cache_write_tokens),
    unitRead: num(r.unit_read_usd),
    unitRest: num(r.unit_rest_usd),
  };
}

export function pricedRun(r: Record<string, SqlValue>): PricedRun {
  return {
    lane: String(r.lane),
    firstCall: Number(r.first_call),
    lastCall: num(r.last_call),
    position: Number(r.position),
    tokens: num(r.tokens),
    blockHash: String(r.block_hash),
  };
}
