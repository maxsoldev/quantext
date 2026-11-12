/**
 * Domain entities to table rows and back. Optional fields are NULL columns; reading a row leaves a NULL field
 * out, so an entity read back equals the one written. JSON columns hold small nested values only.
 */
import type {
  Block,
  BlockKind,
  BlockSource,
  Call,
  CallBlock,
  Compaction,
  JsonValue,
  RequestSection,
  Session,
  TokenBasis,
  ToolCall,
  Usage,
} from "@quantext/shared";
import type { SqlRow, SqlValue } from "./driver.ts";

export const SESSION_COLUMNS = ["id", "parent_id", "harness", "harness_version", "project", "cwd", "started", "ended"];

export function sessionRow(s: Session): SqlValue[] {
  return [s.id, s.parentId, s.harness, s.harnessVersion, s.project, s.cwd, s.started, s.ended].map(nul);
}

export function session(r: SqlRow): Session {
  const s: Session = { id: text(r.id), harness: text(r.harness) };
  put(s, "parentId", r.parent_id);
  put(s, "harnessVersion", r.harness_version);
  put(s, "project", r.project);
  put(s, "cwd", r.cwd);
  put(s, "started", r.started);
  put(s, "ended", r.ended);
  return s;
}

export const CALL_COLUMNS = [
  "id",
  "session_id",
  "idx",
  "lane",
  "ts",
  "model",
  "canonical_model",
  "params",
  "shape_hash",
  "usage_basis",
  "input_tokens",
  "cache_read_tokens",
  "cache_write_tokens",
  "cache_write_5m_tokens",
  "cache_write_1h_tokens",
  "output_tokens",
  "reasoning_output_tokens",
  "speed",
  "service_tier",
  "inference_geo",
  "cost_input_usd",
  "cost_cache_read_usd",
  "cost_cache_write_usd",
  "cost_output_usd",
  "cost_total_usd",
  "price_model",
  "price_source",
  "price_date",
  "price_modifiers",
  "block_count",
  "cache_breakpoints",
  "cache_boundary_tokens",
  "cache_boundary_position",
  "framing_tokens",
  "issues",
];

export function callRow(c: Call): SqlValue[] {
  const u = c.usage;
  const cost = c.cost;
  return [
    c.id,
    c.sessionId,
    c.index,
    c.lane,
    c.ts,
    c.model,
    c.canonicalModel,
    JSON.stringify(c.params),
    c.shapeHash,
    u?.basis,
    u?.inputTokens,
    u?.cacheReadTokens,
    u?.cacheWriteTokens,
    u?.cacheWrite5mTokens,
    u?.cacheWrite1hTokens,
    u?.outputTokens,
    u?.reasoningOutputTokens,
    c.speed,
    c.serviceTier,
    c.inferenceGeo,
    cost?.inputUsd,
    cost?.cacheReadUsd,
    cost?.cacheWriteUsd,
    cost?.outputUsd,
    cost?.totalUsd,
    cost?.price.model,
    cost?.price.source,
    cost?.price.date,
    cost === undefined ? undefined : JSON.stringify(cost.price.modifiers),
    c.blockCount,
    JSON.stringify(c.cacheBreakpoints),
    c.cacheBoundary?.tokens,
    c.cacheBoundary?.position,
    c.framingTokens,
    JSON.stringify(c.issues),
  ].map(nul);
}

export function call(r: SqlRow): Call {
  const c: Call = {
    id: text(r.id),
    sessionId: text(r.session_id),
    index: Number(r.idx),
    ts: text(r.ts),
    model: text(r.model),
    params: json<Call["params"]>(r.params),
    lane: text(r.lane),
    cacheBreakpoints: json<number[]>(r.cache_breakpoints),
    framingTokens: Number(r.framing_tokens),
    issues: json<Call["issues"]>(r.issues),
  };
  put(c, "canonicalModel", r.canonical_model);
  put(c, "shapeHash", r.shape_hash);
  if (r.usage_basis !== null) {
    const usage: Usage = {
      basis: text(r.usage_basis) as Usage["basis"],
      inputTokens: Number(r.input_tokens),
      cacheReadTokens: Number(r.cache_read_tokens),
      cacheWriteTokens: Number(r.cache_write_tokens),
      outputTokens: Number(r.output_tokens),
    };
    putNumber(usage, "cacheWrite5mTokens", r.cache_write_5m_tokens);
    putNumber(usage, "cacheWrite1hTokens", r.cache_write_1h_tokens);
    putNumber(usage, "reasoningOutputTokens", r.reasoning_output_tokens);
    c.usage = usage;
  }
  put(c, "speed", r.speed);
  put(c, "serviceTier", r.service_tier);
  put(c, "inferenceGeo", r.inference_geo);
  if (r.cost_total_usd !== null) {
    c.cost = {
      inputUsd: Number(r.cost_input_usd),
      cacheReadUsd: Number(r.cost_cache_read_usd),
      cacheWriteUsd: Number(r.cost_cache_write_usd),
      outputUsd: Number(r.cost_output_usd),
      totalUsd: Number(r.cost_total_usd),
      price: {
        model: text(r.price_model),
        source: text(r.price_source),
        date: text(r.price_date),
        modifiers: json<string[]>(r.price_modifiers),
      },
    };
  }
  putNumber(c, "blockCount", r.block_count);
  if (r.cache_boundary_tokens !== null) {
    c.cacheBoundary = { tokens: Number(r.cache_boundary_tokens), position: Number(r.cache_boundary_position) };
  }
  return c;
}

export const BLOCK_COLUMNS = ["hash", "content", "kind", "tool", "file_path", "mcp_server", "skill", "text"];

export function blockRow(b: Block, content: string): SqlValue[] {
  return [b.hash, content, b.kind, ...sourceRow(b.source), b.text].map(nul);
}

export function block(r: SqlRow): Block {
  return {
    hash: text(r.hash),
    kind: text(r.kind) as BlockKind,
    source: source(r),
    text: text(r.text),
    content: json(r.content),
  };
}

export const RUN_COLUMNS = [
  "id",
  "session_id",
  "lane",
  "block_hash",
  "position",
  "section",
  "message",
  "tokens",
  "basis",
  "grp",
  "first_call",
  "last_call",
];

export function runRow(r: CallBlock): SqlValue[] {
  return [
    r.id,
    r.sessionId,
    r.lane,
    r.blockHash,
    r.position,
    r.section,
    r.message,
    r.tokens,
    r.basis,
    r.group,
    r.firstCall,
    r.lastCall,
  ].map(nul);
}

export function run(r: SqlRow): CallBlock {
  const out: CallBlock = {
    id: text(r.id),
    sessionId: text(r.session_id),
    lane: text(r.lane),
    blockHash: text(r.block_hash),
    position: Number(r.position),
    section: text(r.section) as RequestSection,
    firstCall: Number(r.first_call),
  };
  putNumber(out, "message", r.message);
  putNumber(out, "tokens", r.tokens);
  if (r.basis !== null) out.basis = text(r.basis) as TokenBasis;
  put(out, "group", r.grp);
  putNumber(out, "lastCall", r.last_call);
  return out;
}

export const TOOL_CALL_COLUMNS = [
  "id",
  "session_id",
  "call_id",
  "name",
  "input",
  "tool",
  "file_path",
  "mcp_server",
  "skill",
  "result_block_hash",
  "is_error",
  "duration_ms",
  "parallel",
  "child_session_id",
];

export function toolCallRow(t: ToolCall): SqlValue[] {
  return [
    t.id,
    t.sessionId,
    t.callId,
    t.name,
    JSON.stringify(t.input),
    ...sourceRow(t.source),
    t.resultBlockHash,
    t.isError ? 1 : 0,
    t.durationMs,
    t.parallel,
    t.childSessionId,
  ].map(nul);
}

export function toolCall(r: SqlRow): ToolCall {
  const t: ToolCall = {
    id: text(r.id),
    sessionId: text(r.session_id),
    callId: text(r.call_id),
    name: text(r.name),
    input: json(r.input),
    source: source(r),
    isError: Number(r.is_error) === 1,
    parallel: Number(r.parallel),
  };
  put(t, "resultBlockHash", r.result_block_hash);
  putNumber(t, "durationMs", r.duration_ms);
  put(t, "childSessionId", r.child_session_id);
  return t;
}

export const COMPACTION_COLUMNS = [
  "id",
  "session_id",
  "ts",
  "trigger",
  "before_tokens",
  "after_tokens",
  "before_call_id",
  "summary_call_id",
];

export function compactionRow(c: Compaction): SqlValue[] {
  return [c.id, c.sessionId, c.ts, c.trigger, c.beforeTokens, c.afterTokens, c.beforeCallId, c.summaryCallId].map(nul);
}

export function compaction(r: SqlRow): Compaction {
  const c: Compaction = { id: text(r.id), sessionId: text(r.session_id), ts: text(r.ts), trigger: text(r.trigger) };
  putNumber(c, "beforeTokens", r.before_tokens);
  putNumber(c, "afterTokens", r.after_tokens);
  put(c, "beforeCallId", r.before_call_id);
  put(c, "summaryCallId", r.summary_call_id);
  return c;
}

function sourceRow(s: BlockSource): (string | undefined)[] {
  return [s.tool, s.filePath, s.mcpServer, s.skill];
}

function source(r: SqlRow): BlockSource {
  const s: BlockSource = {};
  put(s, "tool", r.tool);
  put(s, "filePath", r.file_path);
  put(s, "mcpServer", r.mcp_server);
  put(s, "skill", r.skill);
  return s;
}

/** A JSON column, parsed; `T` is what the store wrote there. */
export function json<T = JsonValue>(value: SqlValue | undefined): T {
  return JSON.parse(text(value)) as T;
}

function text(value: SqlValue | undefined): string {
  return typeof value === "string" ? value : String(value);
}

function nul(value: SqlValue | undefined): SqlValue {
  return value ?? null;
}

/** Set an optional text field from a column, leaving it out when the column is NULL. */
function put<T extends object>(target: T, key: keyof T & string, value: SqlValue | undefined): void {
  if (value !== null && value !== undefined) (target as Record<string, unknown>)[key] = text(value);
}

function putNumber<T extends object>(target: T, key: keyof T & string, value: SqlValue | undefined): void {
  if (value !== null && value !== undefined) (target as Record<string, unknown>)[key] = Number(value);
}
