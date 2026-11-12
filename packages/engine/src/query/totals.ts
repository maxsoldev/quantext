/**
 * A Session's totals with its subagents at any depth, in the same read as its own row of `v_sessions`: a
 * recursive walk down `parent_id` from each root, then the descendants' Calls summed per root (`sub_*` columns).
 */
import type { SessionSummary, SessionTotal } from "@quantext/shared";
import type { SqlRow, SqlValue } from "../store/index.ts";

/**
 * `WITH RECURSIVE` CTEs ending in `sub` (one row per root with descendants) for the roots `SELECT log, id FROM
 * sessions v WHERE <where>`. Join it as `LEFT JOIN sub ON sub.sub_log = v.log AND sub.sub_id = v.id`. `UNION`
 * keeps each (root, descendant) once, so a cycle of parent ids ends.
 */
export function subtreeSql(where: string): string {
  return `WITH RECURSIVE tree(log, root, id) AS (
  SELECT v.log, v.id, v.id FROM sessions v WHERE ${where}
  UNION SELECT s.log, t.root, s.id FROM tree t JOIN sessions s ON s.log = t.log AND s.parent_id = t.id
),
sub AS (
  SELECT t.log AS sub_log, t.root AS sub_id, count(DISTINCT t.id) AS sub_sessions, count(c.id) AS sub_calls,
    coalesce(sum(c.input_tokens), 0) AS sub_input_tokens,
    coalesce(sum(c.cache_read_tokens), 0) AS sub_cache_read_tokens,
    coalesce(sum(c.cache_write_tokens), 0) AS sub_cache_write_tokens,
    coalesce(sum(c.output_tokens), 0) AS sub_output_tokens,
    coalesce(sum(c.cost_input_usd), 0) AS sub_cost_input_usd,
    coalesce(sum(c.cost_cache_read_usd), 0) AS sub_cost_cache_read_usd,
    coalesce(sum(c.cost_cache_write_usd), 0) AS sub_cost_cache_write_usd,
    coalesce(sum(c.cost_output_usd), 0) AS sub_cost_output_usd,
    coalesce(sum(c.cost_total_usd), 0) AS sub_cost_total_usd,
    count(c.usage_basis) - count(c.cost_total_usd) AS sub_unpriced_calls
  FROM tree t LEFT JOIN calls c ON c.log = t.log AND c.session_id = t.id
  WHERE t.id <> t.root GROUP BY t.log, t.root
)`;
}

/** The join to `sub` for `v_sessions v`. */
export const SUB_JOIN = "LEFT JOIN sub ON sub.sub_log = v.log AND sub.sub_id = v.id";

/** The session list's cost order: with the subagents. */
export const TOTAL_COST = "(cost_total_usd + coalesce(sub_cost_total_usd, 0))";

/** A row's `sub_*` columns as the subagents' total (zero when it has none). */
function subagentsOf(r: SqlRow): SessionTotal {
  const n = (v: SqlValue | undefined) => Number(v ?? 0);
  return {
    sessions: n(r.sub_sessions),
    calls: n(r.sub_calls),
    tokens: {
      input: n(r.sub_input_tokens),
      cacheRead: n(r.sub_cache_read_tokens),
      cacheWrite: n(r.sub_cache_write_tokens),
      output: n(r.sub_output_tokens),
    },
    cost: {
      inputUsd: n(r.sub_cost_input_usd),
      cacheReadUsd: n(r.sub_cost_cache_read_usd),
      cacheWriteUsd: n(r.sub_cost_cache_write_usd),
      outputUsd: n(r.sub_cost_output_usd),
      totalUsd: n(r.sub_cost_total_usd),
    },
    unpricedCalls: n(r.sub_unpriced_calls),
  };
}

/** Two totals added, part by part. */
function add(a: SessionTotal, b: SessionTotal): SessionTotal {
  return {
    sessions: a.sessions + b.sessions,
    calls: a.calls + b.calls,
    tokens: {
      input: a.tokens.input + b.tokens.input,
      cacheRead: a.tokens.cacheRead + b.tokens.cacheRead,
      cacheWrite: a.tokens.cacheWrite + b.tokens.cacheWrite,
      output: a.tokens.output + b.tokens.output,
    },
    cost: {
      inputUsd: a.cost.inputUsd + b.cost.inputUsd,
      cacheReadUsd: a.cost.cacheReadUsd + b.cost.cacheReadUsd,
      cacheWriteUsd: a.cost.cacheWriteUsd + b.cost.cacheWriteUsd,
      outputUsd: a.cost.outputUsd + b.cost.outputUsd,
      totalUsd: a.cost.totalUsd + b.cost.totalUsd,
    },
    unpricedCalls: a.unpricedCalls + b.unpricedCalls,
  };
}

/** `SessionSummary.totals` from the Session's own numbers and its row's `sub_*` columns. */
export function totalsOf(
  own: Pick<SessionSummary, "calls" | "tokens" | "cost" | "unpricedCalls">,
  r: SqlRow,
): SessionSummary["totals"] {
  const main: SessionTotal = {
    sessions: 1,
    calls: own.calls,
    tokens: { ...own.tokens },
    cost: { ...own.cost },
    unpricedCalls: own.unpricedCalls,
  };
  const subagents = subagentsOf(r);
  return { main, subagents, all: add(main, subagents) };
}
