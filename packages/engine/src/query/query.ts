/**
 * The query layer: the one read API for the CLI, the HTTP API, the viewer and the mod. Each method is a few indexed
 * queries over the store; Block text is derived from content at read time (by the adapter's codec).
 */
import type {
  BlockDetail,
  BlockKind,
  BlockLifetime,
  BlockPart,
  CacheBreak,
  CacheBreakReason,
  CallContext,
  CallDetail,
  CallIssue,
  CallListOptions,
  CallParams,
  CallResponseDetail,
  CallSummary,
  CompactionDetail,
  ContextBlock,
  ContextCategory,
  ContextDiff,
  IngestEvent,
  Items,
  LaneSummary,
  Lifetime,
  LifetimeOptions,
  MemoryDocumentView,
  Meta,
  Page,
  ProjectSummary,
  PublicEvent,
  QueryReport,
  RequestLog,
  RequestSection,
  ResponseEntry,
  SessionDetail,
  SessionFilter,
  SessionKey,
  SessionSummary,
  StableCallParams,
  StoreCodec,
  TimelineCall,
  TokenBasis,
  TokenGroup,
  ToolCallSummary,
  ToolOutput,
} from "@quantext/shared";
import { blockCosts } from "../core/pricing.ts";
import type { SqlDriver, SqlRow, SqlValue } from "../store/index.ts";
import {
  callFromRow,
  compactionFromRow,
  eventFromRow,
  jsonColumn,
  runFromRow,
  toolCallFromRow,
} from "../store/index.ts";
import { categoryOf, emptyCategories, isDeferred } from "./categories.ts";
import type { LifetimeRow } from "./lifetimes.ts";
import { lifetimes, PRICED_CALLS, PRICED_RUNS, pricedCall, pricedRun } from "./lifetimes.ts";
import { contextParts, partTotals } from "./parts.ts";
import { previewOf } from "./preview.ts";
import { API_VERSION } from "./sql.ts";
import { cacheBreaksSql, installViews, toolOutputsSql } from "./views.ts";

const LIFETIME_SORTS: Record<NonNullable<LifetimeOptions["sort"]>, string> = {
  cost: "lifetime_cost_usd",
  tokens: "lifetime_tokens",
  calls: "calls",
};
/** One Session's tool uses, without lifetimes: `lifetimes.ts` gives those. */
const SESSION_TOOLS = toolOutputsSql(null, "WHERE t.log = ? AND t.session_id = ?", false);
const SESSION_BREAKS = cacheBreaksSql(true);

export interface QueryOptions {
  /** A connection to the store (read-only is enough); the views are made on it when missing. */
  db: SqlDriver;
  /** The adapter's codec: Block text and media from stored content. */
  codec: StoreCodec;
  now?: () => number;
  /** A Session is live when its last event is at most this old. Default 5 minutes. */
  liveWindowMs?: number;
  /** Characters of a Block's display text in a context preview. Default 240. */
  previewChars?: number;
}

export interface Query {
  listSessions(filter?: SessionFilter): Page<SessionSummary>;
  /** Sessions whose id is `id` or starts with it, newest first. */
  findSessions(id: string): SessionKey[];
  getSession(key: SessionKey): SessionDetail | undefined;
  /** The projects with main Sessions, latest first (`listSessions({ project })` takes the name it shows). */
  listProjects(): Items<ProjectSummary>;
  /** Whether the Session exists: one indexed lookup, for a 404 before a list. */
  hasSession(key: SessionKey): boolean;
  /** The store's change cursor now, as `Page.cursor` gives it. */
  changeCursor(): number;
  /** The Session's Calls in order, a page at a time. */
  listCalls(key: SessionKey, options?: CallListOptions): Page<CallSummary>;
  /** One Call, with the provider's own parameters (not stable) in `raw`. */
  getCall(key: SessionKey, index: number): CallDetail | undefined;
  /** Every Call of the Session with its numbers and context-bar totals, without its Blocks: one grouped read. */
  callTimeline(key: SessionKey): Items<TimelineCall>;
  /** The input of Call `index` (its position in the Session), in order, with framing as the last entry. */
  contextAt(key: SessionKey, index: number): CallContext | undefined;
  /** What changed at Call `index` against the previous Call of its lane. */
  contextDiff(key: SessionKey, index: number): ContextDiff | undefined;
  /** What the model answered on Call `index`: its Response Blocks in order, with output tokens and cost. */
  responseAt(key: SessionKey, index: number): CallResponseDetail | undefined;
  getBlock(hash: string, log: number): BlockDetail | undefined;
  /** The bytes of an image or document that Block `block` of log `log` names (`BlockDetail.media`). */
  getMedia(block: string, log: number, hash: string): { mediaType: string; bytes: Uint8Array } | undefined;
  toolCalls(key: SessionKey): Items<ToolCallSummary>;
  /** The compactions, with what was removed and kept (two contexts each, so only here, not in `getSession`). */
  compactions(key: SessionKey): Items<CompactionDetail>;
  /** The Calls whose cache read dropped, with the reason (`v_cache_breaks`). */
  cacheBreaks(key: SessionKey): Items<CacheBreak>;
  /** The Session's Blocks by their lifetime cost in its own Calls. */
  blockLifetimes(key: SessionKey, options?: LifetimeOptions): Items<BlockLifetime>;
  /** The Session's tool uses by their result's lifetime cost. */
  toolOutputs(key: SessionKey, options?: LifetimeOptions): Items<ToolOutput>;
  /** The memory documents of a project (by its path, or its last folder name), by path. */
  projectMemory(project: string): Items<MemoryDocumentView>;
  ingestReport(): QueryReport;
  /** A change event as the API sends it, without the harness's folders: null for memory of no known project. */
  publicEvent(event: IngestEvent): PublicEvent | null;
}

/** One Block of a log, with its kind, source and content. */
const BLOCK_OF_LOG = `SELECT b.*, k.content FROM log_blocks b JOIN blocks k ON k.hash = b.hash
  WHERE b.log = ? AND b.hash = ?`;

const SORTS: Record<NonNullable<SessionFilter["sort"]>, string> = {
  ended: "coalesce(ended, started)",
  started: "started",
  cost: "cost_total_usd",
  calls: "calls",
};

export function createQuery(options: QueryOptions): Query {
  const { db, codec } = options;
  const exists = db.prepare("SELECT 1 FROM sqlite_temp_master WHERE type = 'view' AND name = 'v_sessions'").get();
  if (exists === undefined) installViews(db);
  const now = options.now ?? Date.now;
  const liveWindowMs = options.liveWindowMs ?? 5 * 60_000;
  const previewChars = options.previewChars ?? 240;
  const meta: Meta = { apiVersion: API_VERSION };
  const cache = new Map<string, ReturnType<SqlDriver["prepare"]>>();
  const q = (sql: string) => {
    let s = cache.get(sql);
    if (s === undefined) {
      s = db.prepare(sql);
      cache.set(sql, s);
    }
    return s;
  };
  /** Each Block's lifetime in one Session's Calls (`lifetimes.ts`: linear in its Calls and runs). */
  const sessionLifetimes = (key: SessionKey) =>
    lifetimes(q(PRICED_CALLS).all(key.log, key.id).map(pricedCall), q(PRICED_RUNS).all(key.log, key.id).map(pricedRun));
  const media = (hash: string): Uint8Array => {
    const r = q("SELECT bytes FROM media WHERE hash = ?").get(hash);
    if (!(r?.bytes instanceof Uint8Array)) throw new Error(`the store has no media ${hash}`);
    return r.bytes;
  };
  /** The display text of stored content; media are read only for content that names them. */
  const textOf = (stored: SqlValue | undefined): string => {
    const raw = String(stored);
    const content = jsonColumn(raw);
    return codec.text(raw.includes('"$media"') ? codec.unpackContent(content, media) : content);
  };

  // ---- sessions ----

  const hasSession = (key: SessionKey): boolean =>
    q("SELECT 1 FROM sessions WHERE log = ? AND id = ?").get(key.log, key.id) !== undefined;
  const issuesOf = (logs: readonly number[]): Map<string, SessionSummary["issues"]> => {
    const out = new Map<string, SessionSummary["issues"]>();
    if (logs.length === 0) return out;
    const rows = db
      .prepare(
        `SELECT c.log, c.session_id, i.value ->> '$.kind' AS kind, count(*) AS n
         FROM calls c, json_each(c.issues) i WHERE c.issues <> '[]' AND c.log IN (${logs.map(() => "?").join(",")})
         GROUP BY c.log, c.session_id, kind`,
      )
      .all(...logs);
    for (const r of rows) {
      const k = `${r.log}\0${r.session_id}`;
      const entry = out.get(k) ?? {};
      entry[String(r.kind) as CallIssue["kind"]] = Number(r.n);
      out.set(k, entry);
    }
    return out;
  };
  const summary = (r: SqlRow, issues: Map<string, SessionSummary["issues"]>): SessionSummary => {
    const s: SessionSummary = {
      log: Number(r.log),
      id: String(r.id),
      harness: String(r.harness),
      models: r.models === null ? [] : String(r.models).split(",").sort(),
      calls: Number(r.calls),
      tokens: {
        input: Number(r.input_tokens),
        cacheRead: Number(r.cache_read_tokens),
        cacheWrite: Number(r.cache_write_tokens),
        output: Number(r.output_tokens),
      },
      cost: {
        inputUsd: Number(r.cost_input_usd),
        cacheReadUsd: Number(r.cost_cache_read_usd),
        cacheWriteUsd: Number(r.cost_cache_write_usd),
        outputUsd: Number(r.cost_output_usd),
        totalUsd: Number(r.cost_total_usd),
      },
      unpricedCalls: Number(r.unpriced_calls),
      maxContextTokens: Number(r.max_context_tokens),
      requestLog: String(r.request_log) as RequestLog,
      issues: issues.get(`${r.log}\0${r.id}`) ?? {},
      live: r.ended !== null && now() - Date.parse(String(r.ended)) <= liveWindowMs,
    };
    const opt = (field: keyof SessionSummary, value: SqlValue | undefined) => {
      if (value !== null && value !== undefined) (s as unknown as Record<string, unknown>)[field] = String(value);
    };
    opt("parentId", r.parent_id);
    opt("title", r.title);
    opt("titleSource", r.title_source);
    opt("agentName", r.agent_name);
    opt("harnessVersion", r.harness_version);
    opt("project", r.project);
    opt("cwd", r.cwd);
    opt("started", r.started);
    opt("ended", r.ended);
    if (r.cache_hit_rate !== null) s.cacheHitRate = Number(r.cache_hit_rate);
    return s;
  };
  const projectFilter = (names: readonly string[], params: SqlValue[]): string => {
    const one = () => "(project = ? OR project LIKE ? ESCAPE '!' OR project LIKE ? ESCAPE '!')";
    for (const n of names) {
      const e = n.replace(/[!%_]/g, "!$&");
      params.push(n, `%/${e}`, `%\\${e}`);
    }
    return names.length === 0 ? "0" : `(${names.map(one).join(" OR ")})`;
  };
  const subagentsOf = (keys: readonly SessionKey[]): SessionSummary[] => {
    if (keys.length === 0) return [];
    const logs = [...new Set(keys.map((k) => k.log))];
    const rows = db
      .prepare(
        `SELECT * FROM v_sessions WHERE parent_id IS NOT NULL AND log IN (${logs.map(() => "?").join(",")})
         ORDER BY started, id`,
      )
      .all(...logs);
    const issues = issuesOf(logs);
    return rows.map((r) => summary(r, issues));
  };
  /** Nest each subagent under its parent, at any depth. */
  const nest = (mains: SessionSummary[], children: SessionSummary[]): void => {
    const byKey = new Map<string, SessionSummary>();
    for (const s of [...mains, ...children]) byKey.set(`${s.log}\0${s.id}`, s);
    for (const child of children) {
      const parent = byKey.get(`${child.log}\0${child.parentId ?? ""}`);
      if (parent === undefined) continue;
      parent.subagents ??= [];
      parent.subagents.push(child);
    }
  };

  // ---- calls and context ----

  const callRow = (key: SessionKey, index: number) =>
    q("SELECT * FROM calls WHERE log = ? AND session_id = ? AND idx = ?").get(key.log, key.id, index);
  const toolUsesOf = (key: SessionKey): Map<string, { id: string; name: string }[]> => {
    const out = new Map<string, { id: string; name: string }[]>();
    for (const r of q("SELECT id, call_id, name FROM tool_calls WHERE log = ? AND session_id = ? ORDER BY id").all(
      key.log,
      key.id,
    )) {
      const list = out.get(String(r.call_id)) ?? [];
      list.push({ id: String(r.id), name: String(r.name) });
      out.set(String(r.call_id), list);
    }
    return out;
  };
  const callSummary = (r: SqlRow, tools: { id: string; name: string }[]): CallSummary => {
    const c = callFromRow(r);
    const s: CallSummary = {
      id: c.id,
      index: c.index,
      lane: c.lane,
      ts: c.ts,
      model: c.model,
      params: stableParams(c.params),
      cacheBreakpoints: c.cacheBreakpoints,
      framingTokens: c.framingTokens,
      issues: c.issues,
      toolCalls: tools,
    };
    if (c.usage !== undefined) s.usage = c.usage;
    if (c.cost !== undefined) s.cost = c.cost;
    if (c.cacheBoundary !== undefined) s.cacheBoundary = c.cacheBoundary;
    if (c.blockCount !== undefined) s.blockCount = c.blockCount;
    if (c.turnDurationMs !== undefined) s.turnDurationMs = c.turnDurationMs;
    return s;
  };
  /** The Blocks of one Call: one range lookup on the runs' key, with each Block's kind, source and content. */
  const RUNS_AT = `SELECT r.*, b.kind, b.tool, b.file_path, b.mcp_server, b.skill, b.attachment, b.parts, k.content
    FROM call_blocks r
    JOIN log_blocks b ON b.log = r.log AND b.hash = r.block_hash
    JOIN blocks k ON k.hash = r.block_hash
    WHERE r.log = ? AND r.session_id = ? AND r.lane = ? AND r.first_call <= ?
      AND (r.last_call IS NULL OR r.last_call >= ?)
    ORDER BY r.position`;
  const responseAt = (key: SessionKey, index: number): CallResponseDetail | undefined => {
    const row = hasSession(key) ? callRow(key, index) : undefined;
    if (row === undefined) return undefined;
    const tools = toolUsesOf(key).get(String(row.id)) ?? [];
    const call = callSummary(row, tools);
    const response = callFromRow(row).response;
    const blocks = (response?.blocks ?? []).flatMap((b): ResponseEntry[] => {
      const r = q(BLOCK_OF_LOG).get(key.log, b.hash);
      if (r === undefined) throw new Error(`the response of call ${index} names Block ${b.hash}, not in the store`);
      const source = sourceOf(r);
      const entry: ResponseEntry = {
        hash: b.hash,
        kind: b.kind,
        category: categoryOf(b.kind, "messages", source),
        source,
        ...previewOf(textOf(r.content), previewChars),
      };
      if (b.reasoning !== undefined) entry.reasoning = b.reasoning;
      const tool = b.toolUseId === undefined ? undefined : tools.find((t) => t.id === b.toolUseId);
      if (tool !== undefined) entry.toolCall = tool;
      return [entry];
    });
    const out: CallResponseDetail = {
      ...meta,
      session: { log: key.log, id: key.id },
      call,
      answered: blocks.length > 0,
      blocks,
    };
    if (response?.stopReason !== undefined) out.stopReason = response.stopReason;
    if (call.usage !== undefined) out.outputTokens = call.usage.outputTokens;
    if (call.usage?.reasoningOutputTokens !== undefined) out.reasoningOutputTokens = call.usage.reasoningOutputTokens;
    if (call.cost !== undefined) out.outputUsd = call.cost.outputUsd;
    return out;
  };
  const context = (key: SessionKey, index: number): CallContext | undefined => {
    const row = hasSession(key) ? callRow(key, index) : undefined;
    if (row === undefined) return undefined;
    const call = callSummary(row, toolUsesOf(key).get(String(row.id)) ?? []);
    const rebuilt = call.blockCount !== undefined;
    const runs = rebuilt ? q(RUNS_AT).all(key.log, key.id, call.lane, index, index) : [];
    const boundary = call.cacheBoundary?.position ?? 0;
    const blocks: ContextBlock[] = runs.map((r) => {
      const run = runFromRow(r);
      const source = sourceOf(r);
      const text = textOf(r.content);
      const shown = previewOf(text, previewChars);
      const b: ContextBlock = {
        position: run.position,
        section: run.section,
        hash: run.blockHash,
        kind: String(r.kind) as BlockKind,
        category: categoryOf(String(r.kind) as BlockKind, run.section, source),
        source,
        inCachedPrefix: run.position < boundary,
        ...shown,
        run:
          run.lastCall === undefined
            ? { firstCall: run.firstCall }
            : { firstCall: run.firstCall, lastCall: run.lastCall },
      };
      if (isDeferred(b.kind, b.section)) b.deferred = true;
      if (run.message !== undefined) b.message = run.message;
      if (run.tokens !== undefined) b.tokens = run.tokens;
      if (run.basis !== undefined) b.basis = run.basis;
      if (run.group !== undefined) b.group = run.group;
      if (r.parts !== null && r.parts !== undefined) {
        const parts = JSON.parse(String(r.parts)) as BlockPart[];
        b.parts = contextParts(text, parts, run.tokens, run.basis, previewChars);
      }
      return b;
    });
    if (rebuilt) {
      const framing: ContextBlock = {
        position: blocks.length,
        section: "framing",
        kind: "framing",
        category: "other",
        source: {},
        basis: "framing",
        inCachedPrefix: false,
        preview: "",
        chars: 0,
        truncated: false,
      };
      if (call.usage !== undefined) framing.tokens = call.framingTokens;
      blocks.push(framing);
    }
    if (call.usage !== undefined && call.cost !== undefined && rebuilt) {
      const costs = blockCosts(
        blocks.map((b) => b.tokens ?? 0),
        call.usage,
        call.cost,
      );
      blocks.forEach((b, i) => {
        b.costUsd = costs[i] ?? 0;
      });
    }
    const sections = { tools: 0, system: 0, messages: 0, framing: 0 };
    const categories = emptyCategories();
    for (const b of blocks) {
      sections[b.section] += b.tokens ?? 0;
      categories[b.category] += b.tokens ?? 0;
    }
    const u = call.usage;
    const result: CallContext = {
      ...meta,
      session: { log: key.log, id: key.id },
      lane: call.lane,
      call,
      rebuilt,
      blocks,
      sections,
      categories,
      partTotals: partTotals(blocks),
      totalTokens:
        u === undefined
          ? blocks.reduce((n, b) => n + (b.tokens ?? 0), 0)
          : u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens,
    };
    return result;
  };
  /**
   * The Call to compare Call `index` with: the previous Call of its lane, or the previous Call in time when that one
   * ran on another model (the cache is per model). `modelSwitch` says which.
   */
  const previousOf = (key: SessionKey, call: CallSummary): { index: number; modelSwitch: boolean } | undefined => {
    const inLane = q("SELECT max(idx) AS idx FROM calls WHERE log = ? AND session_id = ? AND lane = ? AND idx < ?").get(
      key.log,
      key.id,
      call.lane,
      call.index,
    )?.idx;
    const before = q(
      "SELECT idx, model FROM calls WHERE log = ? AND session_id = ? AND idx < ? AND usage_basis IS NOT NULL ORDER BY idx DESC LIMIT 1",
    ).get(key.log, key.id, call.index);
    const lane = inLane === null || inLane === undefined ? undefined : Number(inLane);
    if (before !== undefined && before.model !== call.model && (lane === undefined || Number(before.idx) > lane)) {
      return { index: Number(before.idx), modelSwitch: true };
    }
    return lane === undefined ? undefined : { index: lane, modelSwitch: false };
  };

  /**
   * The timeline: the Session's runs grouped by lane, Call range, section and group (one read), then summed per Call
   * by a sweep over each lane's Calls: a run adds its tokens at its first Call and takes them off after its last.
   */
  const timeline = (key: SessionKey): TimelineCall[] => {
    const groups = q(
      `SELECT r.lane, r.first_call, r.last_call, r.section, b.kind, b.tool IS NOT NULL AS by_tool,
         sum(r.tokens) AS tokens
       FROM call_blocks r JOIN log_blocks b ON b.log = r.log AND b.hash = r.block_hash
       WHERE r.log = ? AND r.session_id = ? GROUP BY r.lane, r.first_call, r.last_call, r.section, b.kind, by_tool`,
    ).all(key.log, key.id);
    type Change = { at: number; section: RequestSection; category: ContextCategory; tokens: number };
    const starts = new Map<string, Change[]>();
    const ends = new Map<string, Change[]>();
    for (const g of groups) {
      const section = String(g.section) as RequestSection;
      const kind = String(g.kind) as BlockKind;
      const category = categoryOf(kind, section, Number(g.by_tool) === 1 ? { tool: "" } : {});
      const change = { section, category, tokens: Number(g.tokens ?? 0) };
      const lane = String(g.lane);
      const s = starts.get(lane) ?? [];
      const e = ends.get(lane) ?? [];
      starts.set(lane, s);
      ends.set(lane, e);
      s.push({ ...change, at: Number(g.first_call) });
      if (g.last_call !== null) e.push({ ...change, at: Number(g.last_call) });
    }
    for (const list of [...starts.values(), ...ends.values()]) list.sort((a, b) => a.at - b.at);
    const marks = new Map<number, "summary" | "after">();
    for (const c of compactionsOf(key, false)) {
      if (c.summaryCallIndex !== undefined) marks.set(c.summaryCallIndex, "summary");
      if (c.afterCallIndex !== undefined) marks.set(c.afterCallIndex, "after");
    }
    type Totals = {
      sections: TimelineCall["sections"];
      categories: TimelineCall["categories"];
      start: number;
      end: number;
    };
    const lanes = new Map<string, Totals>();
    const zero = () => ({ tools: 0, system: 0, messages: 0, framing: 0 });
    const calls = q("SELECT * FROM calls WHERE log = ? AND session_id = ? ORDER BY idx").all(key.log, key.id);
    return calls.map((row) => {
      const c = callFromRow(row);
      const t = lanes.get(c.lane) ?? { sections: zero(), categories: emptyCategories(), start: 0, end: 0 };
      lanes.set(c.lane, t);
      const add = (x: Change | undefined, sign: number) => {
        if (x === undefined) return;
        t.sections[x.section] += sign * x.tokens;
        t.categories[x.category] += sign * x.tokens;
      };
      const ending = ends.get(c.lane) ?? [];
      while (t.end < ending.length && (ending[t.end]?.at ?? 0) < c.index) add(ending[t.end++], -1);
      const starting = starts.get(c.lane) ?? [];
      while (t.start < starting.length && (starting[t.start]?.at ?? 0) <= c.index) add(starting[t.start++], 1);
      const rebuilt = c.blockCount !== undefined;
      const framing = rebuilt && c.usage !== undefined ? c.framingTokens : 0;
      const item: TimelineCall = {
        index: c.index,
        lane: c.lane,
        ts: c.ts,
        model: c.model,
        rebuilt,
        sections: rebuilt ? { ...t.sections, framing } : zero(),
        categories: rebuilt ? { ...t.categories, other: t.categories.other + framing } : emptyCategories(),
        issues: c.issues.map((i) => i.kind),
      };
      if (c.usage !== undefined) item.usage = c.usage;
      if (c.cost !== undefined) {
        const { inputUsd, cacheReadUsd, cacheWriteUsd, outputUsd, totalUsd } = c.cost;
        item.cost = { inputUsd, cacheReadUsd, cacheWriteUsd, outputUsd, totalUsd };
      }
      if (c.cacheBoundary !== undefined) item.cacheBoundary = c.cacheBoundary;
      const mark = marks.get(c.index);
      if (mark !== undefined) item.compaction = mark;
      return item;
    });
  };

  // ---- compactions ----

  const group = (blocks: readonly ContextBlock[]): TokenGroup => {
    const categories = emptyCategories();
    let tokens = 0;
    for (const b of blocks) {
      tokens += b.tokens ?? 0;
      categories[b.category] += b.tokens ?? 0;
    }
    return { blocks: blocks.length, tokens, categories };
  };
  const indexOf = (key: SessionKey, callId: string | undefined): number | undefined => {
    if (callId === undefined) return undefined;
    const r = q("SELECT idx FROM calls WHERE log = ? AND id = ?").get(key.log, callId);
    return r === undefined ? undefined : Number(r.idx);
  };
  /** The Session's compactions; `contexts`: also what was removed and kept, from the contexts before and after. */
  const compactionsOf = (key: SessionKey, contexts: boolean): CompactionDetail[] => {
    if (!hasSession(key)) return [];
    const rows = q("SELECT * FROM compactions WHERE log = ? AND session_id = ? ORDER BY ts, id").all(key.log, key.id);
    return rows.map((r) => {
      const c = compactionFromRow(r);
      const detail: CompactionDetail = { ...c };
      const before = indexOf(key, c.beforeCallId);
      const summaryIndex = indexOf(key, c.summaryCallId);
      if (before !== undefined) detail.beforeCallIndex = before;
      if (summaryIndex !== undefined) detail.summaryCallIndex = summaryIndex;
      const lane = before === undefined ? undefined : callRow(key, before)?.lane;
      const after =
        lane === undefined || before === undefined
          ? undefined
          : q(
              `SELECT min(idx) AS idx FROM calls WHERE log = ? AND session_id = ? AND lane = ? AND idx > ?
               AND block_count IS NOT NULL`,
            ).get(key.log, key.id, String(lane), Math.max(before, summaryIndex ?? before))?.idx;
      if (after !== undefined && after !== null) {
        detail.afterCallIndex = Number(after);
        if (!contexts) return detail;
        const was = before === undefined ? undefined : context(key, before);
        const now = context(key, Number(after));
        if (was !== undefined && now !== undefined) {
          const real = (b: ContextBlock) => b.hash !== undefined;
          const kept = new Set(now.blocks.filter(real).map((b) => b.hash));
          detail.removed = group(was.blocks.filter((b) => real(b) && !kept.has(b.hash)));
          detail.kept = group(was.blocks.filter((b) => real(b) && kept.has(b.hash)));
          detail.summaryTokens = now.blocks
            .filter((b) => b.kind === "summary")
            .reduce((n, b) => n + (b.tokens ?? 0), 0);
        }
      }
      return detail;
    });
  };

  // ---- the report ----

  const changeCursor = () => Number(q("SELECT seq FROM change_cursor").get()?.seq ?? 0);

  return {
    changeCursor,
    hasSession,
    listProjects() {
      const rows = q(
        `SELECT project, count(*) AS n, max(coalesce(ended, started)) AS last FROM sessions
         WHERE parent_id IS NULL AND project IS NOT NULL GROUP BY project ORDER BY last IS NULL, last DESC, project`,
      ).all();
      const items = rows.map((r): ProjectSummary => {
        const p: ProjectSummary = { project: String(r.project), sessions: Number(r.n) };
        if (r.last !== null && r.last !== undefined) p.ended = String(r.last);
        return p;
      });
      return { ...meta, items };
    },
    listSessions(filter = {}) {
      // The cursor before the page: a write between them shows up again in the next changedSince, never lost.
      const cursor = changeCursor();
      const params: SqlValue[] = [];
      const where = [
        "(parent_id IS NULL OR NOT EXISTS (SELECT 1 FROM sessions p WHERE p.log = v.log AND p.id = v.parent_id))",
      ];
      if (filter.project !== undefined) where.push(projectFilter([filter.project], params));
      if (filter.changedSince !== undefined) {
        // A main Session changed when it or one of its subagents did.
        where.push(`(changed_seq > ? OR EXISTS (SELECT 1 FROM sessions a WHERE a.log = v.log AND a.parent_id = v.id
          AND a.changed_seq > ?))`);
        params.push(filter.changedSince, filter.changedSince);
      }
      if (filter.search !== undefined && filter.search !== "") {
        where.push("(instr(lower(coalesce(title, '')), lower(?)) > 0 OR instr(id, ?) > 0)");
        params.push(filter.search, filter.search);
      }
      const order = filter.order === "asc" ? "ASC" : "DESC";
      const sort = SORTS[filter.sort ?? "ended"];
      const limit = Math.max(0, filter.limit ?? 50);
      const offset = Math.max(0, filter.offset ?? 0);
      const clause = where.join(" AND ");
      // One pass over the view: the total comes with the page (a page past the end needs a count of its own).
      const rows = db
        .prepare(
          `SELECT *, count(*) OVER () AS total_rows FROM v_sessions v WHERE ${clause}
           ORDER BY ${sort} IS NULL, ${sort} ${order}, log, id LIMIT ? OFFSET ?`,
        )
        .all(...params, limit, offset);
      const total =
        rows[0] !== undefined
          ? Number(rows[0].total_rows)
          : Number(db.prepare(`SELECT count(*) AS n FROM v_sessions v WHERE ${clause}`).get(...params)?.n);
      const issues = issuesOf([...new Set(rows.map((r) => Number(r.log)))]);
      const items = rows.map((r) => summary(r, issues));
      nest(items, subagentsOf(items));
      return { ...meta, total, offset, items, cursor };
    },
    findSessions(id) {
      return q(
        `SELECT log, id FROM sessions WHERE id = ? OR substr(id, 1, length(?)) = ?
         ORDER BY id = ? DESC, coalesce(ended, started) DESC, log DESC`,
      )
        .all(id, id, id, id)
        .map((r) => ({ log: Number(r.log), id: String(r.id) }));
    },
    getSession(key) {
      const row = q("SELECT * FROM v_sessions WHERE log = ? AND id = ?").get(key.log, key.id);
      if (row === undefined) return undefined;
      const issues = issuesOf([key.log]);
      const lanes: LaneSummary[] = q(
        `SELECT lane, min(model) AS model, count(*) AS calls, min(idx) AS first, max(idx) AS last
         FROM calls WHERE log = ? AND session_id = ? GROUP BY lane ORDER BY first`,
      )
        .all(key.log, key.id)
        .map((r) => ({
          lane: String(r.lane),
          model: String(r.model),
          calls: Number(r.calls),
          firstCall: Number(r.first),
          lastCall: Number(r.last),
        }));
      const events = q("SELECT * FROM session_events WHERE log = ? AND session_id = ? ORDER BY ts, id")
        .all(key.log, key.id)
        .map(eventFromRow);
      const subagents = q("SELECT * FROM v_sessions WHERE log = ? AND parent_id = ? ORDER BY started, id")
        .all(key.log, key.id)
        .map((r) => summary(r, issues));
      return {
        ...meta,
        session: summary(row, issues),
        lanes,
        events,
        compactions: compactionsOf(key, false),
        subagents,
      };
    },
    listCalls(key, options = {}) {
      if (!hasSession(key)) return { ...meta, total: 0, offset: 0, items: [] };
      const tools = toolUsesOf(key);
      const lane = options.lane ?? null;
      const after = options.afterIndex ?? -1;
      const counts = q(
        `SELECT count(*) AS total, count(CASE WHEN idx <= ? THEN 1 END) AS before FROM calls
         WHERE log = ? AND session_id = ? AND (? IS NULL OR lane = ?)`,
      ).get(after, key.log, key.id, lane, lane);
      const rows = q(
        `SELECT * FROM calls WHERE log = ? AND session_id = ? AND (? IS NULL OR lane = ?) AND idx > ?
         ORDER BY idx LIMIT ?`,
      ).all(key.log, key.id, lane, lane, after, options.limit ?? 1000);
      const items = rows.map((r) => callSummary(r, tools.get(String(r.id)) ?? []));
      return { ...meta, total: Number(counts?.total), offset: Number(counts?.before), items };
    },
    getCall(key, index) {
      const row = hasSession(key) ? callRow(key, index) : undefined;
      if (row === undefined) return undefined;
      const call = callSummary(row, toolUsesOf(key).get(String(row.id)) ?? []);
      return { ...meta, call, raw: { params: callFromRow(row).params } };
    },
    callTimeline(key) {
      return { ...meta, items: hasSession(key) ? timeline(key) : [] };
    },
    contextAt: context,
    responseAt,
    contextDiff(key, index) {
      const now = context(key, index);
      if (now === undefined) return undefined;
      const prev = previousOf(key, now.call);
      const previous = prev?.index;
      const was = previous === undefined ? undefined : context(key, previous);
      // The same content at the same position: what the provider could read from the cache.
      const runKey = (b: ContextBlock) => `${b.position}:${b.hash ?? ""}`;
      const real = (b: ContextBlock) => b.hash !== undefined;
      const before = new Set((was?.blocks ?? []).filter(real).map(runKey));
      const after = new Set(now.blocks.filter(real).map(runKey));
      const newHere = now.blocks.filter((b) => real(b) && !before.has(runKey(b)));
      const goneHere = (was?.blocks ?? []).filter((b) => real(b) && !after.has(runKey(b)));
      // The same content in both, at another position, moved: it is neither added nor removed.
      const wasAt = new Map(goneHere.map((b) => [b.hash, b.position]));
      const moved = newHere.flatMap((b) => {
        const from = wasAt.get(b.hash);
        return from === undefined ? [] : [{ ...b, from }];
      });
      const movedHashes = new Set(moved.map((b) => b.hash));
      const added = newHere.filter((b) => !movedHashes.has(b.hash));
      const removed = goneHere.filter((b) => !movedHashes.has(b.hash));
      const changed = [...added, ...removed].map((b) => b.position).concat(moved.flatMap((b) => [b.position, b.from]));
      const diff: ContextDiff = {
        ...meta,
        call: index,
        added,
        removed,
        moved,
        uncached: now.blocks.filter((b) => real(b) && before.has(runKey(b)) && !b.inCachedPrefix),
        cacheReadDrop: Math.max(0, (was?.call.usage?.cacheReadTokens ?? 0) - (now.call.usage?.cacheReadTokens ?? 0)),
      };
      if (previous !== undefined) diff.previous = previous;
      if (prev?.modelSwitch === true) diff.modelSwitch = true;
      if (changed.length > 0) diff.firstChange = Math.min(...changed);
      return diff;
    },
    getBlock(hash, log) {
      const r = q(BLOCK_OF_LOG).get(log, hash);
      if (r === undefined) return undefined;
      const content = jsonColumn(r.content);
      const refs = [...String(r.content).matchAll(/"\$media":"([0-9a-f]+)"/g)].map((m) => m[1] ?? "");
      const mediaRows = refs.flatMap((h) => {
        const m = q("SELECT media_type, length(bytes) AS n FROM media WHERE hash = ?").get(h);
        return m === undefined ? [] : [{ hash: h, mediaType: String(m.media_type), bytes: Number(m.n) }];
      });
      const detail: BlockDetail = {
        ...meta,
        hash,
        log,
        kind: String(r.kind) as BlockKind,
        source: sourceOf(r),
        text: textOf(r.content),
        media: mediaRows,
        raw: { content },
      };
      return detail;
    },
    getMedia(block, log, hash) {
      const owner = q(
        "SELECT k.content FROM log_blocks b JOIN blocks k ON k.hash = b.hash WHERE b.log = ? AND b.hash = ?",
      ).get(log, block);
      if (owner === undefined || !String(owner.content).includes(`"$media":"${hash}"`)) return undefined;
      const r = q("SELECT media_type, bytes FROM media WHERE hash = ?").get(hash);
      if (r === undefined || !(r.bytes instanceof Uint8Array)) return undefined;
      return { mediaType: String(r.media_type), bytes: r.bytes };
    },
    toolCalls(key) {
      if (!hasSession(key)) return { ...meta, items: [] };
      const content = (hash: string) => jsonColumn(q("SELECT content FROM blocks WHERE hash = ?").get(hash)?.content);
      const rows = q(
        `SELECT t.*, c.idx AS call_idx,
           (SELECT r.tokens FROM call_blocks r WHERE r.block_hash = t.result_block_hash AND r.log = t.log
             AND r.session_id = t.session_id ORDER BY r.first_call LIMIT 1) AS result_tokens,
           (SELECT r.basis FROM call_blocks r WHERE r.block_hash = t.result_block_hash AND r.log = t.log
             AND r.session_id = t.session_id ORDER BY r.first_call LIMIT 1) AS result_basis
         FROM tool_calls t LEFT JOIN calls c ON c.log = t.log AND c.id = t.call_id
         WHERE t.log = ? AND t.session_id = ? ORDER BY c.idx, t.id`,
      ).all(key.log, key.id);
      const out = rows.map((r) => {
        const t = toolCallFromRow(r, content);
        const s: ToolCallSummary = {
          id: t.id,
          callId: t.callId,
          name: t.name,
          source: t.source,
          input: t.input,
          isError: t.isError,
          parallel: t.parallel,
        };
        if (r.call_idx !== null) s.callIndex = Number(r.call_idx);
        if (t.durationMs !== undefined) s.durationMs = t.durationMs;
        if (t.childSessionId !== undefined) s.childSessionId = t.childSessionId;
        if (t.resultBlockHash !== undefined) s.resultBlockHash = t.resultBlockHash;
        if (r.result_tokens !== null) s.resultTokens = Number(r.result_tokens);
        if (r.result_basis !== null && r.result_basis !== undefined)
          s.resultBasis = String(r.result_basis) as TokenBasis;
        return s;
      });
      return { ...meta, items: out };
    },
    compactions: (key) => ({ ...meta, items: compactionsOf(key, true) }),
    cacheBreaks(key) {
      if (!hasSession(key)) return { ...meta, items: [] };
      const rows = q(`${SESSION_BREAKS} ORDER BY idx`).all(key.log, key.id);
      const items = rows.map((r) => {
        const b: CacheBreak = {
          index: Number(r.idx),
          lane: String(r.lane),
          ts: String(r.ts),
          model: String(r.model),
          previous: {
            index: Number(r.prev_idx),
            ts: String(r.prev_ts),
            model: String(r.prev_model),
            cacheReadTokens: Number(r.prev_cache_read_tokens),
          },
          gapSeconds: Number(r.gap_seconds),
          cacheReadTokens: Number(r.cache_read_tokens),
          dropTokens: Number(r.drop_tokens),
          cacheWriteTokens: Number(r.cache_write_tokens),
          reason: String(r.reason) as CacheBreakReason,
        };
        if (r.break_position !== null) b.breakPosition = Number(r.break_position);
        if (r.break_block_hash !== null) {
          b.breakBlock = { hash: String(r.break_block_hash), kind: String(r.break_kind) as BlockKind };
          if (r.break_tool !== null) b.breakBlock.tool = String(r.break_tool);
        }
        return b;
      });
      return { ...meta, items };
    },
    blockLifetimes(key, options = {}) {
      if (!hasSession(key)) return { ...meta, items: [] };
      const sort = LIFETIME_SORTS[options.sort ?? "cost"] as keyof LifetimeRow;
      const ranked = [...sessionLifetimes(key).values()]
        .sort((a, b) => Number(b[sort] ?? 0) - Number(a[sort] ?? 0) || (a.block_hash < b.block_hash ? -1 : 1))
        .slice(0, Math.max(0, options.limit ?? 50));
      const blocks =
        ranked.length === 0
          ? []
          : db
              .prepare(`SELECT * FROM log_blocks WHERE log = ? AND hash IN (${ranked.map(() => "?").join(",")})`)
              .all(key.log, ...ranked.map((r) => r.block_hash));
      const byHash = new Map(blocks.map((b) => [String(b.hash), b]));
      const items = ranked.map((r): BlockLifetime => {
        const b = byHash.get(r.block_hash) ?? {};
        return {
          hash: r.block_hash,
          kind: String(b.kind) as BlockKind,
          source: sourceOf(b),
          ...lifetimeOf(r as unknown as SqlRow),
        };
      });
      return { ...meta, items };
    },
    toolOutputs(key, options = {}) {
      if (!hasSession(key)) return { ...meta, items: [] };
      const lives = sessionLifetimes(key);
      const sort = LIFETIME_SORTS[options.sort ?? "cost"] as keyof LifetimeRow;
      const rows = q(SESSION_TOOLS)
        .all(key.log, key.id)
        .map((t) => {
          const l = t.result_block_hash === null ? undefined : lives.get(String(t.result_block_hash));
          return l === undefined ? t : { ...t, ...(l as unknown as Record<string, SqlValue>) };
        })
        .sort(
          (a, b) =>
            Number(b[sort] ?? 0) - Number(a[sort] ?? 0) || (String(a.tool_use_id) < String(b.tool_use_id) ? -1 : 1),
        )
        .slice(0, Math.max(0, options.limit ?? 50));
      const items = rows.map((r) => {
        const o: ToolOutput = {
          toolUseId: String(r.tool_use_id),
          tool: String(r.tool),
          source: sourceOf(r),
          isError: Number(r.is_error) === 1,
          ...lifetimeOf(r),
        };
        if (r.call_idx !== null) o.callIndex = Number(r.call_idx);
        if (r.input_summary !== null) {
          o.inputSummary = previewOf(String(r.input_summary), 200).preview;
        }
        if (r.result_block_hash !== null) o.resultBlockHash = String(r.result_block_hash);
        if (r.first_call !== null) o.firstCall = Number(r.first_call);
        if (r.last_call !== null) o.lastCall = Number(r.last_call);
        return o;
      });
      return { ...meta, items };
    },
    projectMemory(project) {
      const logs = q("SELECT DISTINCT l.path, s.project FROM sessions s JOIN logs l ON l.id = s.log")
        .all()
        .filter((r) => {
          const p = r.project === null ? undefined : String(r.project);
          return p !== undefined && (p === project || lastFolder(p) === project);
        });
      const dirs = [...new Set(logs.map((r) => parentOf(String(r.path))))];
      if (dirs.length === 0) return { ...meta, items: [] };
      const docs = db
        .prepare(
          `SELECT path, content, mtime_ms, size FROM project_memory
           WHERE project_dir IN (${dirs.map(() => "?").join(",")}) ORDER BY path, project_dir`,
        )
        .all(...dirs)
        .map((r) => ({
          path: String(r.path),
          content: String(r.content),
          mtimeMs: Number(r.mtime_ms),
          size: Number(r.size),
        }));
      return { ...meta, items: docs };
    },
    publicEvent(event) {
      switch (event.kind) {
        case "calls": {
          const key = { log: event.logId, id: event.sessionId };
          const added = event.added.map((id, i) => ({ id, index: event.addedIndexes[i] ?? -1 }));
          return { kind: "calls", cursor: event.cursor, session: key, added, updated: [...event.updated] };
        }
        case "log-removed":
          return { kind: "log-removed", cursor: event.cursor, logId: event.logId };
        case "memory": {
          const dirs = new Set(event.projectDirs);
          const projects = q("SELECT DISTINCT l.path, s.project FROM sessions s JOIN logs l ON l.id = s.log")
            .all()
            .filter((r) => r.project !== null && dirs.has(parentOf(String(r.path))))
            .map((r) => String(r.project));
          const unique = [...new Set(projects)].sort();
          return unique.length === 0 ? null : { kind: "memory", cursor: event.cursor, projects: unique };
        }
      }
    },
    ingestReport() {
      const kinds = (status: string) => {
        const counts = new Map<string, number>();
        for (const r of q("SELECT log, kind, count FROM report_kinds WHERE status = ? ORDER BY seq").all(status)) {
          counts.set(String(r.kind), (counts.get(String(r.kind)) ?? 0) + Number(r.count));
        }
        return [...counts]
          .map(([kind, count]) => ({ kind, count }))
          .sort((a, b) => b.count - a.count || (a.kind < b.kind ? -1 : 1));
      };
      const issues: QueryReport["issues"] = {};
      for (const r of q(
        `SELECT c.log, i.value ->> '$.kind' AS kind, count(*) AS n FROM calls c, json_each(c.issues) i
         WHERE c.issues <> '[]' GROUP BY c.log, kind`,
      ).all()) {
        const kind = String(r.kind) as CallIssue["kind"];
        issues[kind] = (issues[kind] ?? 0) + Number(r.n);
      }
      const pending = q(
        `SELECT log, path, size - byte_offset AS pending FROM ingest_files
         WHERE kind = 'transcript' AND error IS NULL AND size > byte_offset ORDER BY path`,
      )
        .all()
        .map((r) => ({ path: String(r.path), bytes: Number(r.pending) }));
      const requestLogs = new Map<RequestLog, number>();
      for (const r of q("SELECT log, request_log FROM sessions").all()) {
        const k = String(r.request_log) as RequestLog;
        requestLogs.set(k, (requestLogs.get(k) ?? 0) + 1);
      }
      const report: QueryReport = {
        ...meta,
        unknownRecords: kinds("unknown"),
        ignoredRecords: kinds("ignored"),
        unreadable: q(
          "SELECT r.log, l.path, r.at, r.reason FROM report_unreadable r JOIN logs l ON l.id = r.log ORDER BY r.log, r.seq",
        )
          .all()
          .map((r) => ({ log: String(r.path), at: String(r.at), reason: String(r.reason) })),
        errors: q("SELECT log, path, error FROM ingest_files WHERE error IS NOT NULL ORDER BY path")
          .all()
          .map((r) => ({ path: String(r.path), error: String(r.error) })),
        pending,
        pendingBytes: pending.reduce((n, p) => n + p.bytes, 0),
        scan: q("SELECT path, issue FROM scan_issues ORDER BY path")
          .all()
          .map((r) => ({ path: String(r.path), issue: String(r.issue) })),
        issues,
        requestLogs: [...requestLogs]
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([requestLog, sessions]) => ({ requestLog, sessions })),
      };
      return report;
    },
  };
}

/** The lifetime columns of a view row. */
function lifetimeOf(r: SqlRow): Lifetime {
  const n = (v: SqlValue | undefined) => Number(v ?? 0);
  const l: Lifetime = {
    calls: n(r.calls),
    runs: n(r.runs),
    lifetimeTokens: n(r.lifetime_tokens),
    tokensByPart: { cacheRead: n(r.cache_read_tokens), cacheWrite: n(r.cache_write_tokens), input: n(r.input_tokens) },
    costUsd: {
      cacheRead: n(r.cost_cache_read_usd),
      cacheWrite: n(r.cost_cache_write_usd),
      input: n(r.cost_input_usd),
      total: n(r.lifetime_cost_usd),
    },
  };
  if (r.tokens !== null && r.tokens !== undefined) l.tokens = Number(r.tokens);
  return l;
}

/** The parameters every provider has: the provider's own stay out of the stable types. */
function stableParams(params: CallParams): StableCallParams {
  const { provider: _, ...rest } = params;
  return rest;
}

function sourceOf(r: SqlRow): ContextBlock["source"] {
  const s: ContextBlock["source"] = {};
  if (r.tool !== null && r.tool !== undefined) s.tool = String(r.tool);
  if (r.file_path !== null && r.file_path !== undefined) s.filePath = String(r.file_path);
  if (r.mcp_server !== null && r.mcp_server !== undefined) s.mcpServer = String(r.mcp_server);
  if (r.skill !== null && r.skill !== undefined) s.skill = String(r.skill);
  if (r.attachment !== null && r.attachment !== undefined) s.attachment = String(r.attachment);
  return s;
}

/** The folder of a path, with `/` or `\` separators. */
function parentOf(path: string): string {
  const at = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return at <= 0 ? path : path.slice(0, at);
}

/** The last folder name of a path, with `/` or `\` separators. */
function lastFolder(path: string): string {
  return (
    path
      .split(/[\\/]/)
      .filter((p) => p !== "")
      .at(-1) ?? path
  );
}
