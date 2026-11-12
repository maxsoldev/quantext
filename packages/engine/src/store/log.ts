/**
 * One log in the store: the rows that the adapter's deltas gave for one main transcript and its subagent
 * transcripts, its report, the read position of each file and the parser snapshot. Every write is one transaction.
 */
import type {
  Block,
  Call,
  CallBlock,
  ContentLookup,
  ContentPart,
  JsonValue,
  SessionDelta,
  SessionGraph,
  StoreCodec,
  ToolCall,
} from "@quantext/shared";
import type { SqlDriver, SqlRow, SqlValue } from "./driver.ts";
import {
  block,
  CALL_COLUMNS,
  COMPACTION_COLUMNS,
  call,
  callRow,
  compaction,
  compactionRow,
  EVENT_COLUMNS,
  event,
  eventRow,
  json,
  LOG_BLOCK_COLUMNS,
  logBlockRow,
  RUN_COLUMNS,
  run,
  runRow,
  SESSION_COLUMNS,
  session,
  sessionRow,
  TOOL_CALL_COLUMNS,
  toolCall,
  toolCallRow,
} from "./rows.ts";
import type { Statements } from "./statements.ts";
import { upsertSql } from "./statements.ts";

/** Where the reader is in one file of a log. */
export interface FileMark {
  path: string;
  /** The transcript name the parser knows the file by. */
  transcript: string;
  kind: "transcript" | "meta";
  /** Device and inode (or the platform's file id): a new id at the same path means the file was replaced. */
  fileId?: string;
  size: number;
  mtimeMs?: number;
  /** Bytes read and given to the parser, up to the end of the last complete line. */
  offset: number;
  /** A hash of some bytes before the offset, to see a file rewritten in place. */
  fingerprint?: string;
  /** Why the file could not be read, when it could not. */
  error?: string;
}

export interface LogBatch {
  deltas: readonly SessionDelta[];
  /** The parser snapshot after these deltas. */
  snapshot?: JsonValue;
  /** File marks to set (by path). */
  files?: readonly FileMark[];
}

/** The Calls a write added and updated, by Session, in the order the deltas named them. */
export interface WriteResult {
  /** The log's id in the store (`SessionKey.log`). */
  log: number;
  /** The store's change cursor after the write: it grew when the write changed a Session. */
  cursor: number;
  calls: { sessionId: string; added: string[]; addedIndexes: number[]; updated: string[] }[];
  /** Every Session the write changed (its Calls or anything else), in the order the deltas named them. */
  sessions: string[];
}

export interface LogStore {
  readonly path: string;
  /** The log's id in the store (`SessionKey.log`). */
  readonly id: number;
  /** Set when opening the log emptied it (another adapter version wrote it): the cursor after, its projects before. */
  readonly emptied?: { cursor: number; projects: string[] };
  /** The projects of the log's Sessions. */
  projects(): string[];
  /** What the parser may look up: everything written to this log so far. */
  readonly lookup: ContentLookup;
  snapshot(): JsonValue | undefined;
  files(): FileMark[];
  /** Apply the deltas, set the snapshot and the file marks, in one transaction: all of it is kept, or none. */
  write(batch: LogBatch): WriteResult;
  /**
   * Delete everything of this log (rows, report, file marks, snapshot) in one transaction, to read it again.
   * Returns the change cursor after it.
   */
  reset(): number;
  /** The log as one SessionGraph: its rows and the Blocks its deltas reported. */
  graph(): SessionGraph;
}

const UPSERT_SESSION = upsertSql("sessions", SESSION_COLUMNS);
const UPSERT_CALL = upsertSql("calls", CALL_COLUMNS);
/** A run is one Block at one position from its first Call on: that is its key (its id is made of the same parts). */
const UPSERT_RUN = upsertSql("call_blocks", RUN_COLUMNS, ["session_id", "lane", "first_call", "position"]);
const UPSERT_TOOL_CALL = upsertSql("tool_calls", TOOL_CALL_COLUMNS);
const UPSERT_COMPACTION = upsertSql("compactions", COMPACTION_COLUMNS);
const UPSERT_EVENT = upsertSql("session_events", EVENT_COLUMNS);
const UPSERT_MESSAGE = upsertSql("messages", ["key", "role", "blocks"], ["key"]);
const UPSERT_SHAPE = upsertSql("shapes", ["key", "tools", "system"], ["key"]);
const UPSERT_RECORD = upsertSql("records", ["key", "value"], ["key"]);
const UPSERT_LOG_BLOCK = upsertSql("log_blocks", LOG_BLOCK_COLUMNS, ["hash"]);
/**
 * What the store derives for a Call when it writes it: its tokens before the cache boundary (the Blocks wholly inside
 * the Cached prefix; NULL when not split), its price per cache-read token, and per other input token (cache write,
 * or plain input when it wrote none). The lifetime cost reads them from the lane index.
 */
const SET_DERIVED = `UPDATE calls SET cache_boundary_offset = CASE WHEN cache_boundary_position IS NULL THEN NULL
  ELSE (SELECT coalesce(sum(r.tokens), 0) FROM call_blocks r
    WHERE r.log = calls.log AND r.session_id = calls.session_id AND r.lane = calls.lane AND r.first_call <= calls.idx
      AND (r.last_call IS NULL OR r.last_call >= calls.idx) AND r.position < calls.cache_boundary_position) END,
  unit_read_usd = CASE WHEN cache_read_tokens > 0 THEN cost_cache_read_usd / cache_read_tokens END,
  unit_rest_usd = CASE WHEN cache_write_tokens > 0 THEN cost_cache_write_usd / cache_write_tokens
    WHEN input_tokens > 0 THEN cost_input_usd / input_tokens END
  WHERE log = ? AND id = ?`;
const UPSERT_FILE = `INSERT INTO ingest_files
  (path, log, transcript, kind, file_id, size, mtime_ms, byte_offset, fingerprint, error)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (path) DO UPDATE SET log = excluded.log, transcript = excluded.transcript, kind = excluded.kind,
    file_id = excluded.file_id, size = excluded.size, mtime_ms = excluded.mtime_ms,
    byte_offset = excluded.byte_offset, fingerprint = excluded.fingerprint, error = excluded.error`;

export function openLog(db: SqlDriver, sql: Statements, path: string, harness: string, codec: StoreCodec): LogStore {
  sql
    .get("INSERT INTO logs (path, harness, adapter_version) VALUES (?, ?, ?) ON CONFLICT (path) DO NOTHING")
    .run(path, harness, codec.version);
  const row = sql.get("SELECT id, harness, adapter_version FROM logs WHERE path = ?").get(path);
  if (row === undefined) throw new Error(`log ${path} was not created`);
  if (row.harness !== harness) throw new Error(`log ${path} is a ${String(row.harness)} log, not ${harness}`);
  const id = Number(row.id);
  const projects = (): string[] =>
    sql
      .get("SELECT DISTINCT project FROM sessions WHERE log = ? AND project IS NOT NULL ORDER BY project")
      .all(id)
      .map((r) => String(r.project));
  const reset = (): number =>
    db.transaction(() => {
      sql.get("DELETE FROM logs WHERE id = ?").run(id);
      sql
        .get("INSERT INTO logs (id, path, harness, adapter_version) VALUES (?, ?, ?, ?)")
        .run(id, path, harness, codec.version);
      sql.get("UPDATE change_cursor SET seq = seq + 1").run();
      return Number(sql.get("SELECT seq FROM change_cursor").get()?.seq);
    });
  // Another adapter version read this log differently: empty it, so that ingest reads it again from the start.
  let emptied: { cursor: number; projects: string[] } | undefined;
  if (Number(row.adapter_version) !== codec.version) {
    const before = projects();
    emptied = { cursor: reset(), projects: before };
  }
  const one = (query: string, ...params: SqlValue[]) => sql.get(query).get(id, ...params);
  const all = (query: string, ...params: SqlValue[]) => sql.get(query).all(id, ...params);

  const media = (hash: string): Uint8Array => {
    const r = sql.get("SELECT bytes FROM media WHERE hash = ?").get(hash);
    if (!(r?.bytes instanceof Uint8Array)) throw new Error(`the store has no media ${hash}`);
    return r.bytes;
  };
  const content = (hash: string): JsonValue => {
    const r = sql.get("SELECT content FROM blocks WHERE hash = ?").get(hash);
    if (r === undefined) throw new Error(`the store has no content for block ${hash}`);
    return codec.unpackContent(json(r.content), media);
  };
  const blockOf = (r: SqlRow): Block => {
    const c = content(String(r.hash));
    return block(r, c, codec.text(c));
  };
  const parts = (hashes: SqlValue | undefined): ContentPart[] =>
    json<string[]>(hashes).map((hash) => ({ hash, content: content(hash) }));

  const lookup: ContentLookup = {
    record(key) {
      const m = one("SELECT role, blocks FROM messages WHERE log = ? AND key = ?", key);
      if (m !== undefined) return codec.unpack({ kind: "message", key, role: String(m.role), parts: parts(m.blocks) });
      const s = one("SELECT tools, system FROM shapes WHERE log = ? AND key = ?", key);
      if (s !== undefined) return codec.unpack({ kind: "shape", key, tools: parts(s.tools), system: parts(s.system) });
      const r = one("SELECT value FROM records WHERE log = ? AND key = ?", key);
      return r === undefined ? undefined : codec.unpack({ kind: "value", key, value: json(r.value) });
    },
    block(hash): Block | undefined {
      const r = one("SELECT * FROM log_blocks WHERE log = ? AND hash = ?", hash);
      return r === undefined ? undefined : blockOf(r);
    },
    call(callId): Call | undefined {
      const r = one("SELECT * FROM calls WHERE log = ? AND id = ?", callId);
      return r === undefined ? undefined : call(r);
    },
    toolCall(toolCallId): ToolCall | undefined {
      const r = one("SELECT * FROM tool_calls WHERE log = ? AND id = ?", toolCallId);
      return r === undefined ? undefined : toolCall(r, content);
    },
    openRuns(sessionId, lane): CallBlock[] {
      return all(
        "SELECT * FROM call_blocks WHERE log = ? AND session_id = ? AND lane = ? AND last_call IS NULL",
        sessionId,
        lane,
      ).map(run);
    },
  };

  /** Insert content once (its media apart): a hash already stored is not serialised again. */
  const putContent = (hash: string, value: JsonValue): void => {
    if (sql.get("SELECT 1 FROM blocks WHERE hash = ?").get(hash) !== undefined) return;
    const packed = codec.packContent(value);
    for (const m of packed.media) {
      sql
        .get("INSERT INTO media (hash, media_type, bytes) VALUES (?, ?, ?) ON CONFLICT DO NOTHING")
        .run(m.hash, m.mediaType, m.bytes);
    }
    sql.get("INSERT INTO blocks (hash, content) VALUES (?, ?)").run(hash, JSON.stringify(packed.content));
  };
  const ensureContent = (list: readonly ContentPart[]): string => {
    for (const part of list) putContent(part.hash, part.content);
    return JSON.stringify(list.map((p) => p.hash));
  };

  type Changed = Map<string, { added: string[]; addedIndexes: number[]; updated: string[] }>;
  const apply = (delta: SessionDelta, result: Changed, touched: Set<string>, calls: Set<string>) => {
    for (const s of delta.sessions) touched.add(s.id);
    for (const c of delta.calls) {
      touched.add(c.sessionId);
      calls.add(c.id);
    }
    for (const x of [...delta.callBlocks, ...delta.toolCalls, ...delta.compactions, ...delta.events]) {
      touched.add(x.sessionId);
    }
    for (const record of delta.records) {
      const stored = codec.pack(record);
      if (stored.kind === "message") {
        sql.get(UPSERT_MESSAGE).run(id, stored.key, stored.role, ensureContent(stored.parts));
      } else if (stored.kind === "shape") {
        sql.get(UPSERT_SHAPE).run(id, stored.key, ensureContent(stored.tools), ensureContent(stored.system));
      } else {
        sql.get(UPSERT_RECORD).run(id, stored.key, JSON.stringify(stored.value));
      }
    }
    for (const b of delta.blocks) {
      putContent(b.hash, b.content);
      sql.get(UPSERT_LOG_BLOCK).run(id, ...logBlockRow(b));
    }
    for (const s of delta.sessions) sql.get(UPSERT_SESSION).run(id, ...sessionRow(s));
    for (const c of delta.calls) {
      const isNew = one("SELECT 1 FROM calls WHERE log = ? AND id = ?", c.id) === undefined;
      sql.get(UPSERT_CALL).run(id, ...callRow(c));
      const entry = result.get(c.sessionId) ?? { added: [], addedIndexes: [], updated: [] };
      result.set(c.sessionId, entry);
      if (isNew) {
        entry.added.push(c.id);
        entry.addedIndexes.push(c.index);
      } else if (!entry.added.includes(c.id) && !entry.updated.includes(c.id)) entry.updated.push(c.id);
    }
    for (const r of delta.callBlocks) sql.get(UPSERT_RUN).run(id, ...runRow(r));
    for (const t of delta.toolCalls) {
      // The input is in the tool use Block (stored with its message): kept once, there.
      const byBlock =
        t.blockHash !== undefined && sql.get("SELECT 1 FROM blocks WHERE hash = ?").get(t.blockHash) !== undefined;
      sql.get(UPSERT_TOOL_CALL).run(id, ...toolCallRow(t, byBlock));
    }
    for (const c of delta.compactions) sql.get(UPSERT_COMPACTION).run(id, ...compactionRow(c));
    for (const e of delta.events) sql.get(UPSERT_EVENT).run(id, ...eventRow(e));
    const counts = [
      ["unknown", delta.report.unknownRecords],
      ["ignored", delta.report.ignoredRecords],
    ] as const;
    for (const [status, list] of counts) {
      for (const { kind, count } of list) {
        sql
          .get(
            `INSERT INTO report_kinds (log, status, kind, count, seq)
             VALUES (?, ?, ?, ?, (SELECT coalesce(max(seq), 0) + 1 FROM report_kinds WHERE log = ?))
             ON CONFLICT (log, status, kind) DO UPDATE SET count = count + excluded.count`,
          )
          .run(id, status, kind, count, id);
      }
    }
    for (const { at, reason } of delta.report.unreadable) {
      sql
        .get(
          `INSERT INTO report_unreadable (log, seq, at, reason)
           VALUES (?, (SELECT coalesce(max(seq), 0) + 1 FROM report_unreadable WHERE log = ?), ?, ?)`,
        )
        .run(id, id, at, reason);
    }
  };

  return {
    path,
    id,
    ...(emptied === undefined ? {} : { emptied }),
    projects,
    lookup,
    snapshot() {
      const r = sql.get("SELECT snapshot FROM logs WHERE id = ?").get(id);
      return r?.snapshot === null || r === undefined ? undefined : json(r.snapshot);
    },
    files: () => all("SELECT * FROM ingest_files WHERE log = ? ORDER BY path").map(fileMark),
    write(batch) {
      return db.transaction(() => {
        const result: Changed = new Map();
        const touched = new Set<string>();
        const calls = new Set<string>();
        for (const delta of batch.deltas) apply(delta, result, touched, calls);
        // After every run of the batch is in: what the store derives for each written Call.
        for (const callId of calls) sql.get(SET_DERIVED).run(id, callId);
        let cursor = Number(sql.get("SELECT seq FROM change_cursor").get()?.seq ?? 0);
        if (touched.size > 0) {
          cursor++;
          sql.get("UPDATE change_cursor SET seq = ?").run(cursor);
          for (const sessionId of touched) {
            sql.get("UPDATE sessions SET changed_seq = ? WHERE log = ? AND id = ?").run(cursor, id, sessionId);
          }
        }
        if (batch.snapshot !== undefined) {
          sql.get("UPDATE logs SET snapshot = ? WHERE id = ?").run(JSON.stringify(batch.snapshot), id);
        }
        for (const f of batch.files ?? []) {
          sql
            .get(UPSERT_FILE)
            .run(
              f.path,
              id,
              f.transcript,
              f.kind,
              f.fileId ?? null,
              f.size,
              f.mtimeMs ?? null,
              f.offset,
              f.fingerprint ?? null,
              f.error ?? null,
            );
        }
        return {
          log: id,
          cursor,
          calls: [...result].map(([sessionId, c]) => ({ sessionId, ...c })),
          sessions: [...touched],
        };
      });
    },
    reset,
    graph(): SessionGraph {
      const rows = (table: string) => all(`SELECT * FROM ${table} WHERE log = ? ORDER BY id`);
      const kinds = (status: string) =>
        all("SELECT kind, count FROM report_kinds WHERE log = ? AND status = ? ORDER BY seq", status).map((r) => ({
          kind: String(r.kind),
          count: Number(r.count),
        }));
      const blocks = all("SELECT * FROM log_blocks WHERE log = ? ORDER BY hash");
      return {
        sessions: rows("sessions").map(session),
        calls: rows("calls").map(call),
        blocks: blocks.map(blockOf),
        callBlocks: rows("call_blocks").map(run),
        toolCalls: rows("tool_calls").map((r) => toolCall(r, content)),
        compactions: rows("compactions").map(compaction),
        events: rows("session_events").map(event),
        report: {
          unknownRecords: kinds("unknown"),
          ignoredRecords: kinds("ignored"),
          unreadable: all("SELECT at, reason FROM report_unreadable WHERE log = ? ORDER BY seq").map((r) => ({
            at: String(r.at),
            reason: String(r.reason),
          })),
        },
      };
    },
  };
}

function fileMark(r: SqlRow): FileMark {
  const mark: FileMark = {
    path: String(r.path),
    transcript: String(r.transcript),
    kind: r.kind === "meta" ? "meta" : "transcript",
    size: Number(r.size),
    offset: Number(r.byte_offset),
  };
  if (r.file_id !== null) mark.fileId = String(r.file_id);
  if (r.mtime_ms !== null) mark.mtimeMs = Number(r.mtime_ms);
  if (r.fingerprint !== null) mark.fingerprint = String(r.fingerprint);
  if (r.error !== null) mark.error = String(r.error);
  return mark;
}
