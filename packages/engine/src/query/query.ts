/**
 * The query layer: the one read API for the CLI, the HTTP API, the viewer and the mod. Each method is a few indexed
 * queries over the store; Block text is derived from content at read time (by the adapter's codec). Demo mode is
 * applied here, so every consumer gets it: only allowed projects, and no local paths.
 */
import type {
  BlockDetail,
  BlockKind,
  CallContext,
  CallIssue,
  CallSummary,
  CompactionDetail,
  ContextBlock,
  ContextDiff,
  DemoOptions,
  JsonValue,
  LaneSummary,
  MemoryDocumentView,
  Page,
  QueryReport,
  RequestLog,
  SessionDetail,
  SessionFilter,
  SessionKey,
  SessionSummary,
  StoreCodec,
  TokenGroup,
  ToolCallSummary,
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
import { categoryOf, emptyCategories } from "./categories.ts";
import { createRedactor, lastFolder, projectAllowed } from "./redact.ts";
import { installViews } from "./views.ts";

export interface QueryOptions {
  /** A connection to the store (read-only is enough); the views are made on it when missing. */
  db: SqlDriver;
  /** The adapter's codec: Block text and media from stored content. */
  codec: StoreCodec;
  demo?: DemoOptions;
  /** The home folder and user name to hide in demo mode. */
  home?: string;
  user?: string;
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
  listCalls(key: SessionKey, lane?: string): CallSummary[];
  /** The input of Call `index` (its position in the Session), in order, with framing as the last entry. */
  contextAt(key: SessionKey, index: number): CallContext | undefined;
  /** What changed at Call `index` against the previous Call of its lane. */
  contextDiff(key: SessionKey, index: number): ContextDiff | undefined;
  getBlock(hash: string, log: number): BlockDetail | undefined;
  getMedia(hash: string): { mediaType: string; bytes: Uint8Array } | undefined;
  toolCalls(key: SessionKey): ToolCallSummary[];
  compactions(key: SessionKey): CompactionDetail[];
  /** The memory documents of a project (by its path, or its last folder name), by path. */
  projectMemory(project: string): MemoryDocumentView[];
  ingestReport(): QueryReport;
}

const SORTS: Record<NonNullable<SessionFilter["sort"]>, string> = {
  ended: "coalesce(ended, started)",
  started: "started",
  cost: "cost_total_usd",
  calls: "calls",
};

export function createQuery(options: QueryOptions): Query {
  const { db, codec, demo } = options;
  const exists = db.prepare("SELECT 1 FROM sqlite_temp_master WHERE type = 'view' AND name = 'v_sessions'").get();
  if (exists === undefined) installViews(db);
  const now = options.now ?? Date.now;
  const liveWindowMs = options.liveWindowMs ?? 5 * 60_000;
  const previewChars = options.previewChars ?? 240;
  const redactor = createRedactor({ ...nonEmpty("home", options.home), ...nonEmpty("user", options.user) });
  const allowed = demo?.projects;
  const redacting = demo?.redactPaths === true;
  const cache = new Map<string, ReturnType<SqlDriver["prepare"]>>();
  const q = (sql: string) => {
    let s = cache.get(sql);
    if (s === undefined) {
      s = db.prepare(sql);
      cache.set(sql, s);
    }
    return s;
  };
  /** The value with local paths hidden, in demo mode. */
  const hide = <T>(value: T, root?: string): T =>
    redacting ? (redactor.json(value as unknown as JsonValue, root) as unknown as T) : value;
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

  /** The project of a visible Session (undefined: hidden by demo mode), and its key. */
  const sessionProject = (key: SessionKey): { project: string | undefined } | undefined => {
    const r = q("SELECT project FROM sessions WHERE log = ? AND id = ?").get(key.log, key.id);
    if (r === undefined) return undefined;
    const project = r.project === null ? undefined : String(r.project);
    return projectAllowed(project, allowed) ? { project } : undefined;
  };
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
    if (!redacting) return s;
    const root = s.project;
    const shown = hide(s, root);
    if (root !== undefined) shown.project = lastFolder(root);
    return shown;
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
      params: c.params,
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
  const RUNS_AT = `SELECT r.*, b.kind, b.tool, b.file_path, b.mcp_server, b.skill, b.attachment, k.content
    FROM call_blocks r
    JOIN log_blocks b ON b.log = r.log AND b.hash = r.block_hash
    JOIN blocks k ON k.hash = r.block_hash
    WHERE r.log = ? AND r.session_id = ? AND r.lane = ? AND r.first_call <= ?
      AND (r.last_call IS NULL OR r.last_call >= ?)
    ORDER BY r.position`;
  const context = (key: SessionKey, index: number): CallContext | undefined => {
    const found = sessionProject(key);
    const row = callRow(key, index);
    if (found === undefined || row === undefined) return undefined;
    const call = callSummary(row, toolUsesOf(key).get(String(row.id)) ?? []);
    const rebuilt = call.blockCount !== undefined;
    const runs = rebuilt ? q(RUNS_AT).all(key.log, key.id, call.lane, index, index) : [];
    const boundary = call.cacheBoundary?.position ?? 0;
    const blocks: ContextBlock[] = runs.map((r) => {
      const run = runFromRow(r);
      const source = sourceOf(r);
      const text = textOf(r.content);
      const flat = text.replace(/\s+/g, " ").trim();
      const b: ContextBlock = {
        position: run.position,
        section: run.section,
        hash: run.blockHash,
        kind: String(r.kind) as BlockKind,
        category: categoryOf(String(r.kind) as BlockKind, source),
        source,
        inCachedPrefix: run.position < boundary,
        preview: flat.length > previewChars ? `${flat.slice(0, previewChars - 1)}…` : flat,
        chars: text.length,
        truncated: flat.length > previewChars,
        run:
          run.lastCall === undefined
            ? { firstCall: run.firstCall }
            : { firstCall: run.firstCall, lastCall: run.lastCall },
      };
      if (run.message !== undefined) b.message = run.message;
      if (run.tokens !== undefined) b.tokens = run.tokens;
      if (run.basis !== undefined) b.basis = run.basis;
      if (run.group !== undefined) b.group = run.group;
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
      session: { log: key.log, id: key.id },
      lane: call.lane,
      call,
      rebuilt,
      blocks,
      sections,
      categories,
      totalTokens:
        u === undefined
          ? blocks.reduce((n, b) => n + (b.tokens ?? 0), 0)
          : u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens,
    };
    return hide(result, found.project);
  };
  const previousInLane = (key: SessionKey, lane: string, index: number): number | undefined => {
    const r = q("SELECT max(idx) AS idx FROM calls WHERE log = ? AND session_id = ? AND lane = ? AND idx < ?").get(
      key.log,
      key.id,
      lane,
      index,
    );
    return r?.idx === null || r === undefined ? undefined : Number(r.idx);
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
  const compactionsOf = (key: SessionKey): CompactionDetail[] => {
    const found = sessionProject(key);
    if (found === undefined) return [];
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

  /** Logs with a visible Session; undefined: every log. */
  const visibleLogs = (): Set<number> | undefined => {
    if (allowed === undefined) return undefined;
    const out = new Set<number>();
    for (const r of q("SELECT DISTINCT log, project FROM sessions").all()) {
      if (projectAllowed(r.project === null ? undefined : String(r.project), allowed)) out.add(Number(r.log));
    }
    return out;
  };

  return {
    listSessions(filter = {}) {
      const params: SqlValue[] = [];
      const where = [
        "(parent_id IS NULL OR NOT EXISTS (SELECT 1 FROM sessions p WHERE p.log = v.log AND p.id = v.parent_id))",
      ];
      if (allowed !== undefined) where.push(projectFilter(allowed, params));
      if (filter.project !== undefined) where.push(projectFilter([filter.project], params));
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
      return { total, offset, items };
    },
    findSessions(id) {
      return q(
        `SELECT log, id, project FROM sessions WHERE id = ? OR substr(id, 1, length(?)) = ?
         ORDER BY id = ? DESC, coalesce(ended, started) DESC, log DESC`,
      )
        .all(id, id, id, id)
        .filter((r) => projectAllowed(r.project === null ? undefined : String(r.project), allowed))
        .map((r) => ({ log: Number(r.log), id: String(r.id) }));
    },
    getSession(key) {
      if (sessionProject(key) === undefined) return undefined;
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
      const project = row.project === null ? undefined : String(row.project);
      const events = q("SELECT * FROM session_events WHERE log = ? AND session_id = ? ORDER BY ts, id")
        .all(key.log, key.id)
        .map(eventFromRow);
      const subagents = q("SELECT * FROM v_sessions WHERE log = ? AND parent_id = ? ORDER BY started, id")
        .all(key.log, key.id)
        .map((r) => summary(r, issues));
      return {
        session: summary(row, issues),
        lanes,
        events: hide(events, project),
        compactions: compactionsOf(key),
        subagents,
      };
    },
    listCalls(key, lane) {
      if (sessionProject(key) === undefined) return [];
      const tools = toolUsesOf(key);
      const rows =
        lane === undefined
          ? q("SELECT * FROM calls WHERE log = ? AND session_id = ? ORDER BY idx").all(key.log, key.id)
          : q("SELECT * FROM calls WHERE log = ? AND session_id = ? AND lane = ? ORDER BY idx").all(
              key.log,
              key.id,
              lane,
            );
      return rows.map((r) => callSummary(r, tools.get(String(r.id)) ?? []));
    },
    contextAt: context,
    contextDiff(key, index) {
      const now = context(key, index);
      if (now === undefined) return undefined;
      const previous = previousInLane(key, now.lane, index);
      const was = previous === undefined ? undefined : context(key, previous);
      // The same content at the same position: what the provider could read from the cache.
      const runKey = (b: ContextBlock) => `${b.position}:${b.hash ?? ""}`;
      const real = (b: ContextBlock) => b.hash !== undefined;
      const before = new Set((was?.blocks ?? []).filter(real).map(runKey));
      const after = new Set(now.blocks.filter(real).map(runKey));
      const added = now.blocks.filter((b) => real(b) && !before.has(runKey(b)));
      const removed = (was?.blocks ?? []).filter((b) => real(b) && !after.has(runKey(b)));
      const changed = [...added, ...removed].map((b) => b.position);
      const diff: ContextDiff = {
        call: index,
        added,
        removed,
        uncached: now.blocks.filter((b) => real(b) && before.has(runKey(b)) && !b.inCachedPrefix),
        cacheReadDrop: Math.max(0, (was?.call.usage?.cacheReadTokens ?? 0) - (now.call.usage?.cacheReadTokens ?? 0)),
      };
      if (previous !== undefined) diff.previous = previous;
      if (changed.length > 0) diff.firstChange = Math.min(...changed);
      return diff;
    },
    getBlock(hash, log) {
      const visible = visibleLogs();
      if (visible !== undefined && !visible.has(log)) return undefined;
      const r = q(
        `SELECT b.*, k.content FROM log_blocks b JOIN blocks k ON k.hash = b.hash WHERE b.log = ? AND b.hash = ?`,
      ).get(log, hash);
      if (r === undefined) return undefined;
      const content = jsonColumn(r.content);
      const refs = [...String(r.content).matchAll(/"\$media":"([0-9a-f]+)"/g)].map((m) => m[1] ?? "");
      const mediaRows = refs.flatMap((h) => {
        const m = q("SELECT media_type, length(bytes) AS n FROM media WHERE hash = ?").get(h);
        return m === undefined ? [] : [{ hash: h, mediaType: String(m.media_type), bytes: Number(m.n) }];
      });
      const project = q("SELECT project FROM sessions WHERE log = ? AND parent_id IS NULL LIMIT 1").get(log)?.project;
      const detail: BlockDetail = {
        hash,
        log,
        kind: String(r.kind) as BlockKind,
        source: sourceOf(r),
        text: textOf(r.content),
        content,
        media: mediaRows,
      };
      return hide(detail, project === null || project === undefined ? undefined : String(project));
    },
    getMedia(hash) {
      const r = q("SELECT media_type, bytes FROM media WHERE hash = ?").get(hash);
      if (r === undefined || !(r.bytes instanceof Uint8Array)) return undefined;
      return { mediaType: String(r.media_type), bytes: r.bytes };
    },
    toolCalls(key) {
      const found = sessionProject(key);
      if (found === undefined) return [];
      const content = (hash: string) => jsonColumn(q("SELECT content FROM blocks WHERE hash = ?").get(hash)?.content);
      const rows = q(
        `SELECT t.*, c.idx AS call_idx,
           (SELECT r.tokens FROM call_blocks r WHERE r.block_hash = t.result_block_hash AND r.log = t.log
             AND r.session_id = t.session_id ORDER BY r.first_call LIMIT 1) AS result_tokens
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
        return s;
      });
      return hide(out, found.project);
    },
    compactions: compactionsOf,
    projectMemory(project) {
      const logs = q("SELECT DISTINCT l.path, s.project FROM sessions s JOIN logs l ON l.id = s.log")
        .all()
        .filter((r) => {
          const p = r.project === null ? undefined : String(r.project);
          return p !== undefined && projectAllowed(p, allowed) && (p === project || lastFolder(p) === project);
        });
      const dirs = [...new Set(logs.map((r) => parentOf(String(r.path))))];
      const root = logs[0]?.project;
      if (dirs.length === 0) return [];
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
      return hide(docs, root === null || root === undefined ? undefined : String(root));
    },
    ingestReport() {
      const visible = visibleLogs();
      const ok = (log: SqlValue | undefined) => visible === undefined || visible.has(Number(log));
      const kinds = (status: string) => {
        const counts = new Map<string, number>();
        for (const r of q("SELECT log, kind, count FROM report_kinds WHERE status = ? ORDER BY seq").all(status)) {
          if (ok(r.log)) counts.set(String(r.kind), (counts.get(String(r.kind)) ?? 0) + Number(r.count));
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
        if (!ok(r.log)) continue;
        const kind = String(r.kind) as CallIssue["kind"];
        issues[kind] = (issues[kind] ?? 0) + Number(r.n);
      }
      const pending = q(
        `SELECT log, path, size - byte_offset AS pending FROM ingest_files
         WHERE kind = 'transcript' AND error IS NULL AND size > byte_offset ORDER BY path`,
      )
        .all()
        .filter((r) => ok(r.log))
        .map((r) => ({ path: String(r.path), bytes: Number(r.pending) }));
      const requestLogs = new Map<RequestLog, number>();
      for (const r of q("SELECT log, request_log FROM sessions").all()) {
        if (!ok(r.log)) continue;
        const k = String(r.request_log) as RequestLog;
        requestLogs.set(k, (requestLogs.get(k) ?? 0) + 1);
      }
      const report: QueryReport = {
        unknownRecords: kinds("unknown"),
        ignoredRecords: kinds("ignored"),
        unreadable: q(
          "SELECT r.log, l.path, r.at, r.reason FROM report_unreadable r JOIN logs l ON l.id = r.log ORDER BY r.log, r.seq",
        )
          .all()
          .filter((r) => ok(r.log))
          .map((r) => ({ log: String(r.path), at: String(r.at), reason: String(r.reason) })),
        errors: q("SELECT log, path, error FROM ingest_files WHERE error IS NOT NULL ORDER BY path")
          .all()
          .filter((r) => ok(r.log))
          .map((r) => ({ path: String(r.path), error: String(r.error) })),
        pending,
        pendingBytes: pending.reduce((n, p) => n + p.bytes, 0),
        // A scan issue belongs to no log: in demo mode, none is shown.
        scan:
          visible === undefined
            ? q("SELECT path, issue FROM scan_issues ORDER BY path")
                .all()
                .map((r) => ({ path: String(r.path), issue: String(r.issue) }))
            : [],
        issues,
        requestLogs: [...requestLogs]
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([requestLog, sessions]) => ({ requestLog, sessions })),
      };
      return hide(report);
    },
  };
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

function nonEmpty<K extends string>(key: K, value: string | undefined): { [k in K]?: string } {
  return value === undefined || value === "" ? {} : ({ [key]: value } as { [k in K]: string });
}
