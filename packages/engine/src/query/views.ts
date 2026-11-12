/**
 * The SQL views for agents (`qx sql`), documented in docs/schema.md "Views". They are TEMP views, made on each
 * connection the query layer opens, so that they change with the engine and need no migration. The query layer
 * reads `v_sessions` itself, so that `qx sql` and the API give the same numbers.
 */
import type { SqlDriver } from "../store/index.ts";

/** Any run's open end: larger than every Call index. */
const OPEN = "9223372036854775807";

/** Each split Call of a lane joined with every run that covers it (one row per Block per Call). */
const RUN_CALLS = `call_blocks r JOIN calls c ON c.log = r.log AND c.session_id = r.session_id AND c.lane = r.lane
  AND c.idx BETWEEN r.first_call AND coalesce(r.last_call, ${OPEN})`;

const SESSIONS = `
CREATE TEMP VIEW v_sessions AS
SELECT s.log, s.id, s.parent_id, s.title, s.title_source, s.agent_name, s.harness, s.harness_version, s.project,
  s.cwd, s.started, s.ended, s.request_log, s.changed_seq,
  count(c.id) AS calls,
  group_concat(DISTINCT coalesce(c.canonical_model, c.model)) AS models,
  coalesce(sum(c.input_tokens), 0) AS input_tokens,
  coalesce(sum(c.cache_read_tokens), 0) AS cache_read_tokens,
  coalesce(sum(c.cache_write_tokens), 0) AS cache_write_tokens,
  coalesce(sum(c.output_tokens), 0) AS output_tokens,
  coalesce(sum(c.cost_input_usd), 0) AS cost_input_usd,
  coalesce(sum(c.cost_cache_read_usd), 0) AS cost_cache_read_usd,
  coalesce(sum(c.cost_cache_write_usd), 0) AS cost_cache_write_usd,
  coalesce(sum(c.cost_output_usd), 0) AS cost_output_usd,
  coalesce(sum(c.cost_total_usd), 0) AS cost_total_usd,
  count(c.usage_basis) - count(c.cost_total_usd) AS unpriced_calls,
  coalesce(max(c.input_tokens + c.cache_read_tokens + c.cache_write_tokens), 0) AS max_context_tokens,
  CAST(sum(c.cache_read_tokens) AS REAL)
    / nullif(sum(c.input_tokens + c.cache_read_tokens + c.cache_write_tokens), 0) AS cache_hit_rate,
  count(CASE WHEN c.issues <> '[]' THEN 1 END) AS calls_with_issues
FROM sessions s LEFT JOIN calls c ON c.log = s.log AND c.session_id = s.id
GROUP BY s.log, s.id`;

const CALLS = `
CREATE TEMP VIEW v_calls AS
SELECT c.log, c.session_id, c.idx, c.id, c.lane, c.ts, c.model, c.canonical_model,
  c.params ->> '$.effort' AS effort, c.params ->> '$.reasoning.mode' AS reasoning,
  c.params ->> '$.maxTokens' AS max_tokens, c.usage_basis,
  c.input_tokens, c.cache_read_tokens, c.cache_write_tokens, c.output_tokens, c.reasoning_output_tokens,
  c.input_tokens + c.cache_read_tokens + c.cache_write_tokens AS input_total,
  CAST(c.cache_read_tokens AS REAL)
    / nullif(c.input_tokens + c.cache_read_tokens + c.cache_write_tokens, 0) AS cache_hit_rate,
  c.cost_input_usd, c.cost_cache_read_usd, c.cost_cache_write_usd, c.cost_output_usd, c.cost_total_usd,
  c.block_count, c.cache_boundary_tokens, c.cache_boundary_position, c.framing_tokens,
  json_array_length(c.issues) AS issue_count,
  (SELECT group_concat(i.value ->> '$.kind', ',') FROM json_each(c.issues) i) AS issue_kinds,
  c.turn_duration_ms
FROM calls c`;

const CONTEXT = `
CREATE TEMP VIEW v_context AS
SELECT r.log, r.session_id, r.lane, r.first_call,
  coalesce(r.last_call, (SELECT max(l.idx) FROM calls l
    WHERE l.log = r.log AND l.session_id = r.session_id AND l.lane = r.lane)) AS last_call,
  r.last_call IS NULL AS open, r.position, r.section, r.message, r.block_hash,
  b.kind, b.tool, b.file_path, b.mcp_server, b.skill, b.attachment, r.tokens, r.basis, r.grp,
  (SELECT count(*) FROM calls l WHERE l.log = r.log AND l.session_id = r.session_id AND l.lane = r.lane
    AND l.idx BETWEEN r.first_call AND coalesce(r.last_call, ${OPEN})) AS calls
FROM call_blocks r JOIN log_blocks b ON b.log = r.log AND b.hash = r.block_hash`;

/**
 * The lifetime cost of each Block of a log: a run's tokens count for each Call of its lane in its range. Per Call,
 * a Block wholly inside the Cached prefix is priced at the Call's price per cache-read token; the Block at the
 * boundary has the rest of the cache read (`cache_read_tokens` less the store's `cache_boundary_offset`); the
 * rest of a Block at the price of the cache write, or of plain input when the Call wrote no cache. This is core's
 * `blockCosts` for every Call whose input tokens are its framing tokens. A run is priced as read in all its
 * Calls, then corrected for the Calls where it lies at or after the boundary. `session`: only one Session's runs
 * are read; the query then takes (log, session id).
 */
export function lifetimeSql(session = false): string {
  const runs = session ? "WHERE r.log = ? AND r.session_id = ?" : "";
  const after = "r.position >= c.cache_boundary_position";
  const rest = `(CASE WHEN r.position > c.cache_boundary_position THEN r.tokens
    ELSE r.tokens - min(r.tokens, max(0, c.cache_read_tokens - c.cache_boundary_offset)) END)`;
  return `
WITH per_run AS (
  SELECT r.log, r.block_hash, r.tokens, count(*) AS calls, sum(c.unit_read_usd) AS unit_read,
    sum(CASE WHEN ${after} THEN ${rest} END) AS rest,
    sum(CASE WHEN ${after} THEN ${rest} * c.unit_read_usd END) AS rest_read_usd,
    sum(CASE WHEN ${after} THEN ${rest} * c.unit_rest_usd END) AS rest_usd,
    sum(CASE WHEN ${after} AND c.cache_write_tokens > 0 THEN ${rest} END) AS wr,
    sum(CASE WHEN ${after} AND c.cache_write_tokens > 0 THEN ${rest} * c.unit_rest_usd END) AS wr_usd
  FROM ${RUN_CALLS} ${runs}
  GROUP BY r.log, r.session_id, r.lane, r.first_call, r.position
),
priced AS (
  SELECT log, block_hash, tokens, calls, tokens * calls AS lifetime_tokens,
    tokens * calls - coalesce(rest, 0) AS rd, coalesce(wr, 0) AS wr, coalesce(rest, 0) - coalesce(wr, 0) AS inp,
    tokens * coalesce(unit_read, 0) - coalesce(rest_read_usd, 0) AS rd_usd, coalesce(wr_usd, 0) AS wr_usd,
    coalesce(rest_usd, 0) - coalesce(wr_usd, 0) AS inp_usd
  FROM per_run
)
SELECT p.log, p.block_hash, b.kind, b.tool, b.file_path, b.mcp_server, b.skill, b.attachment,
  count(*) AS runs, sum(p.calls) AS calls, max(p.tokens) AS tokens,
  coalesce(sum(p.lifetime_tokens), 0) AS lifetime_tokens,
  coalesce(sum(p.rd), 0) AS cache_read_tokens,
  sum(p.wr) AS cache_write_tokens,
  sum(p.inp) AS input_tokens,
  coalesce(sum(p.rd_usd), 0) AS cost_cache_read_usd,
  sum(p.wr_usd) AS cost_cache_write_usd,
  sum(p.inp_usd) AS cost_input_usd,
  coalesce(sum(p.rd_usd), 0) + sum(p.wr_usd) + sum(p.inp_usd) AS lifetime_cost_usd
FROM priced p JOIN log_blocks b ON b.log = p.log AND b.hash = p.block_hash
GROUP BY p.log, p.block_hash`;
}

/**
 * Each tool use with its result Block's lifetime cost. `lifetime`: the lifetime rows to join (the view, or a
 * Session's own); `where` filters the tool uses (`t`).
 */
export function toolOutputsSql(lifetime: string, where = ""): string {
  return `
SELECT t.log, t.session_id, t.id AS tool_use_id, t.name AS tool, t.mcp_server, t.file_path, t.skill, t.is_error,
  c.idx AS call_idx,
  substr(coalesce(t.input, (SELECT json_extract(k.content, '$.input') FROM blocks k WHERE k.hash = t.block_hash)),
    1, 200) AS input_summary,
  t.result_block_hash, l.tokens, l.calls, l.runs,
  (SELECT min(r.first_call) FROM call_blocks r WHERE r.block_hash = t.result_block_hash AND r.log = t.log
    AND r.session_id = t.session_id) AS first_call,
  (SELECT max(coalesce(r.last_call, (SELECT max(m.idx) FROM calls m
      WHERE m.log = r.log AND m.session_id = r.session_id AND m.lane = r.lane)))
    FROM call_blocks r WHERE r.block_hash = t.result_block_hash AND r.log = t.log
    AND r.session_id = t.session_id) AS last_call,
  l.lifetime_tokens, l.cache_read_tokens, l.cache_write_tokens, l.input_tokens,
  l.cost_cache_read_usd, l.cost_cache_write_usd, l.cost_input_usd, l.lifetime_cost_usd
FROM tool_calls t
LEFT JOIN calls c ON c.log = t.log AND c.id = t.call_id
LEFT JOIN ${lifetime} l ON l.log = t.log AND l.block_hash = t.result_block_hash
${where}`;
}

const LIFETIME = `CREATE TEMP VIEW v_block_lifetime_cost AS ${lifetimeSql()}`;

const TOOL_OUTPUTS = `CREATE TEMP VIEW v_tool_outputs AS ${toolOutputsSql("v_block_lifetime_cost")}`;

/**
 * Calls whose cache read dropped against the previous Call: of their lane, or the previous Call in time when that one
 * ran on another model (the cache belongs to a model). The reason, first that fits: a compaction between them, a
 * model switch, a pause longer than the cache's time to live (5 minutes, or 1 hour when the previous Call wrote
 * its cache for an hour), else a change early in the request. `session`: only one Session's Calls are read; the
 * query then takes (log, session id).
 */
export function cacheBreaksSql(session = false): string {
  return `
WITH ordered AS (
  SELECT c.log, c.session_id, c.lane, c.idx, c.id AS call_id, c.ts, c.model, c.cache_read_tokens,
    c.cache_write_tokens, c.input_tokens, c.cache_boundary_position, c.block_count,
    lag(c.idx) OVER lane_w AS l_idx, lag(c.ts) OVER lane_w AS l_ts, lag(c.model) OVER lane_w AS l_model,
    lag(c.cache_read_tokens) OVER lane_w AS l_cr, lag(c.cache_write_1h_tokens) OVER lane_w AS l_w1h,
    lag(c.idx) OVER time_w AS t_idx, lag(c.ts) OVER time_w AS t_ts, lag(c.model) OVER time_w AS t_model,
    lag(c.cache_read_tokens) OVER time_w AS t_cr, lag(c.cache_write_1h_tokens) OVER time_w AS t_w1h
  FROM calls c WHERE c.usage_basis IS NOT NULL ${session ? "AND c.log = ? AND c.session_id = ?" : ""}
  WINDOW lane_w AS (PARTITION BY c.log, c.session_id, c.lane ORDER BY c.idx),
    time_w AS (PARTITION BY c.log, c.session_id ORDER BY c.idx)
),
paired AS (
  SELECT *, coalesce(t_model <> model AND (l_idx IS NULL OR t_idx > l_idx), 0) AS switched FROM ordered
),
prev AS (
  SELECT log, session_id, lane, idx, call_id, ts, model, cache_read_tokens, cache_write_tokens, input_tokens,
    cache_boundary_position, block_count,
    CASE WHEN switched THEN t_idx ELSE l_idx END AS prev_idx,
    CASE WHEN switched THEN t_ts ELSE l_ts END AS prev_ts,
    CASE WHEN switched THEN t_model ELSE l_model END AS prev_model,
    CASE WHEN switched THEN t_cr ELSE l_cr END AS prev_cache_read_tokens,
    CASE WHEN switched THEN t_w1h ELSE l_w1h END AS prev_w1h
  FROM paired
)
SELECT x.log, x.session_id, x.lane, x.idx, x.call_id, x.ts, x.model, x.prev_idx, x.prev_ts, x.prev_model,
  CAST(round((julianday(x.ts) - julianday(x.prev_ts)) * 86400) AS INTEGER) AS gap_seconds,
  x.prev_cache_read_tokens, x.cache_read_tokens, x.prev_cache_read_tokens - x.cache_read_tokens AS drop_tokens,
  x.cache_write_tokens, x.input_tokens, x.cache_boundary_position AS break_position, x.block_count,
  b.block_hash AS break_block_hash, k.kind AS break_kind, k.tool AS break_tool,
  CASE
    WHEN k.kind = 'summary' OR EXISTS (SELECT 1 FROM compactions m WHERE m.log = x.log AND m.session_id = x.session_id
      AND m.ts > x.prev_ts AND m.ts <= x.ts) THEN 'compaction'
    WHEN x.prev_model <> x.model THEN 'model-switch'
    WHEN (julianday(x.ts) - julianday(x.prev_ts)) * 86400 > CASE WHEN x.prev_w1h > 0 THEN 3600 ELSE 300 END
      THEN 'ttl'
    ELSE 'prefix-change'
  END AS reason
FROM prev x
LEFT JOIN call_blocks b ON b.log = x.log AND b.session_id = x.session_id AND b.lane = x.lane
  AND b.first_call <= x.idx AND coalesce(b.last_call, ${OPEN}) >= x.idx AND b.position = x.cache_boundary_position
LEFT JOIN log_blocks k ON k.log = b.log AND k.hash = b.block_hash
WHERE x.cache_read_tokens < x.prev_cache_read_tokens`;
}

const CACHE_BREAKS = `CREATE TEMP VIEW v_cache_breaks AS ${cacheBreaksSql()}`;

/** The names of the views, as documented. */
export const VIEWS = [
  "v_sessions",
  "v_calls",
  "v_context",
  "v_block_lifetime_cost",
  "v_tool_outputs",
  "v_cache_breaks",
] as const;

/** Make the views on this connection (TEMP: they belong to it, and need no write to the store). */
export function installViews(db: SqlDriver): void {
  for (const sql of [SESSIONS, CALLS, CONTEXT, LIFETIME, TOOL_OUTPUTS, CACHE_BREAKS]) db.exec(sql);
}
