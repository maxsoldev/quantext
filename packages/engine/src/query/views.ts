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
  s.cwd, s.started, s.ended, s.request_log,
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
 * A run's tokens count for each Call of its lane in its range; a Call with no Usage has no tokens. Per Call, a
 * Block wholly inside the Cached prefix is priced at the Call's cache read price, the rest at its cache
 * write price (its input price when it wrote no cache). The Block at the boundary is split by token offset: the
 * read part is the cache read less the Blocks before it (the \`straddle\` rows). This is core's \`blockCosts\` for
 * every Call whose input tokens are its framing tokens.
 */
const LIFETIME = `
CREATE TEMP VIEW v_block_lifetime_cost AS
WITH per_run AS (
  SELECT r.log, r.block_hash, max(r.tokens) AS tokens, count(*) AS calls, sum(r.tokens) AS lifetime_tokens,
    sum(CASE WHEN r.position < c.cache_boundary_position THEN r.tokens END) AS rd,
    sum(CASE WHEN r.position >= c.cache_boundary_position AND c.cache_write_tokens > 0 THEN r.tokens END) AS wr,
    sum(CASE WHEN r.position < c.cache_boundary_position
      THEN r.tokens * c.cost_cache_read_usd / c.cache_read_tokens END) AS rd_usd,
    sum(CASE WHEN r.position < c.cache_boundary_position THEN NULL WHEN c.cache_write_tokens > 0
      THEN r.tokens * c.cost_cache_write_usd / c.cache_write_tokens END) AS wr_usd,
    sum(CASE WHEN r.position >= c.cache_boundary_position AND c.cache_write_tokens = 0
      THEN r.tokens * c.cost_input_usd / nullif(c.input_tokens, 0) END) AS inp_usd
  FROM ${RUN_CALLS}
  GROUP BY r.log, r.session_id, r.lane, r.first_call, r.position
),
boundary AS (
  SELECT c.log, c.cache_read_tokens AS cr, c.cache_write_tokens AS cw, c.input_tokens AS it,
    c.cost_cache_read_usd AS cr_usd, c.cost_cache_write_usd AS cw_usd, c.cost_input_usd AS it_usd,
    sum(CASE WHEN r.position < c.cache_boundary_position THEN r.tokens ELSE 0 END) AS before,
    max(CASE WHEN r.position = c.cache_boundary_position THEN r.block_hash END) AS block_hash,
    max(CASE WHEN r.position = c.cache_boundary_position THEN r.tokens END) AS tokens
  FROM calls c JOIN call_blocks r ON r.log = c.log AND r.session_id = c.session_id AND r.lane = c.lane
    AND r.first_call <= c.idx AND (r.last_call IS NULL OR r.last_call >= c.idx)
    AND r.position <= c.cache_boundary_position
  WHERE c.usage_basis IS NOT NULL AND c.cache_read_tokens > 0
  GROUP BY c.log, c.id
),
straddle AS (
  SELECT log, block_hash, min(tokens, max(0, cr - before)) AS rd, cr, cw, it, cr_usd, cw_usd, it_usd
  FROM boundary WHERE block_hash IS NOT NULL
),
parts AS (
  SELECT log, block_hash, 1 AS runs, calls, tokens, lifetime_tokens, rd, wr,
    lifetime_tokens - coalesce(rd, 0) - coalesce(wr, 0) AS inp, rd_usd, wr_usd, inp_usd
  FROM per_run
  UNION ALL
  SELECT log, block_hash, 0, 0, NULL, 0, rd,
    CASE WHEN cw > 0 THEN -rd ELSE 0 END, CASE WHEN cw > 0 THEN 0 ELSE -rd END,
    rd * cr_usd / cr,
    CASE WHEN cw > 0 THEN -rd * cw_usd / cw ELSE 0 END,
    CASE WHEN cw > 0 THEN 0 ELSE -rd * it_usd / nullif(it, 0) END
  FROM straddle WHERE rd > 0
)
SELECT p.log, p.block_hash, b.kind, b.tool, b.file_path, b.mcp_server, b.skill, b.attachment,
  sum(p.runs) AS runs, sum(p.calls) AS calls, max(p.tokens) AS tokens,
  coalesce(sum(p.lifetime_tokens), 0) AS lifetime_tokens,
  coalesce(sum(p.rd), 0) AS cache_read_tokens,
  coalesce(sum(p.wr), 0) AS cache_write_tokens,
  coalesce(sum(p.inp), 0) AS input_tokens,
  coalesce(sum(p.rd_usd), 0) AS cost_cache_read_usd,
  coalesce(sum(p.wr_usd), 0) AS cost_cache_write_usd,
  coalesce(sum(p.inp_usd), 0) AS cost_input_usd,
  coalesce(sum(p.rd_usd), 0) + coalesce(sum(p.wr_usd), 0) + coalesce(sum(p.inp_usd), 0) AS lifetime_cost_usd
FROM parts p JOIN log_blocks b ON b.log = p.log AND b.hash = p.block_hash
GROUP BY p.log, p.block_hash`;

const TOOL_OUTPUTS = `
CREATE TEMP VIEW v_tool_outputs AS
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
LEFT JOIN v_block_lifetime_cost l ON l.log = t.log AND l.block_hash = t.result_block_hash`;

const CACHE_BREAKS = `
CREATE TEMP VIEW v_cache_breaks AS
SELECT x.log, x.session_id, x.lane, x.idx, x.call_id, x.ts, x.model, x.prev_idx, x.prev_ts,
  CAST(round((julianday(x.ts) - julianday(x.prev_ts)) * 86400) AS INTEGER) AS gap_seconds,
  x.prev_cache_read_tokens, x.cache_read_tokens, x.prev_cache_read_tokens - x.cache_read_tokens AS drop_tokens,
  x.cache_write_tokens, x.input_tokens, x.cache_boundary_position AS break_position, x.block_count,
  b.block_hash AS break_block_hash, k.kind AS break_kind, k.tool AS break_tool
FROM (
  SELECT c.log, c.session_id, c.lane, c.idx, c.id AS call_id, c.ts, c.model, c.cache_read_tokens,
    c.cache_write_tokens, c.input_tokens, c.cache_boundary_position, c.block_count,
    lag(c.idx) OVER w AS prev_idx, lag(c.ts) OVER w AS prev_ts, lag(c.cache_read_tokens) OVER w AS prev_cache_read_tokens
  FROM calls c WHERE c.usage_basis IS NOT NULL
  WINDOW w AS (PARTITION BY c.log, c.session_id, c.lane ORDER BY c.idx)
) x
LEFT JOIN call_blocks b ON b.log = x.log AND b.session_id = x.session_id AND b.lane = x.lane
  AND b.first_call <= x.idx AND coalesce(b.last_call, ${OPEN}) >= x.idx AND b.position = x.cache_boundary_position
LEFT JOIN log_blocks k ON k.log = b.log AND k.hash = b.block_hash
WHERE x.cache_read_tokens < x.prev_cache_read_tokens`;

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
