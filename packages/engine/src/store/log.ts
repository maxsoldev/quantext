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
  RecordCodec,
  SessionDelta,
  SessionGraph,
  ToolCall,
} from "@quantext/shared";
import type { SqlDriver, SqlRow, SqlValue } from "./driver.ts";
import {
  BLOCK_COLUMNS,
  block,
  blockRow,
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
  calls: { sessionId: string; added: string[]; updated: string[] }[];
}

export interface LogStore {
  readonly path: string;
  /** What the parser may look up: everything written to this log so far. */
  readonly lookup: ContentLookup;
  snapshot(): JsonValue | undefined;
  files(): FileMark[];
  /** Apply the deltas, set the snapshot and the file marks, in one transaction: all of it is kept, or none. */
  write(batch: LogBatch): WriteResult;
  /** Delete everything of this log (rows, report, file marks, snapshot) in one transaction, to read it again. */
  reset(): void;
  /** The log as one SessionGraph: its rows and the Blocks its deltas reported. */
  graph(): SessionGraph;
}

const UPSERT_SESSION = upsertSql("sessions", SESSION_COLUMNS);
const UPSERT_CALL = upsertSql("calls", CALL_COLUMNS);
const UPSERT_RUN = upsertSql("call_blocks", RUN_COLUMNS);
const UPSERT_TOOL_CALL = upsertSql("tool_calls", TOOL_CALL_COLUMNS);
const UPSERT_COMPACTION = upsertSql("compactions", COMPACTION_COLUMNS);
const UPSERT_EVENT = upsertSql("session_events", EVENT_COLUMNS);
const UPSERT_MESSAGE = upsertSql("messages", ["key", "role", "blocks"], "key");
const UPSERT_SHAPE = upsertSql("shapes", ["key", "tools", "system"], "key");
const UPSERT_RECORD = upsertSql("records", ["key", "value"], "key");
/** A classified Block fills in a row that so far held only content; the first classification stays. */
const UPSERT_BLOCK = `INSERT INTO blocks (${BLOCK_COLUMNS.join(", ")}) VALUES (?${", ?".repeat(BLOCK_COLUMNS.length - 1)})
  ON CONFLICT (hash) DO UPDATE SET ${BLOCK_COLUMNS.slice(2)
    .map((c) => `${c} = excluded.${c}`)
    .join(", ")} WHERE blocks.kind IS NULL`;
const UPSERT_FILE = `INSERT INTO ingest_files
  (path, log, transcript, kind, file_id, size, mtime_ms, byte_offset, fingerprint, error)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (path) DO UPDATE SET log = excluded.log, transcript = excluded.transcript, kind = excluded.kind,
    file_id = excluded.file_id, size = excluded.size, mtime_ms = excluded.mtime_ms,
    byte_offset = excluded.byte_offset, fingerprint = excluded.fingerprint, error = excluded.error`;

export function openLog(db: SqlDriver, sql: Statements, path: string, harness: string, codec: RecordCodec): LogStore {
  sql.get("INSERT INTO logs (path, harness) VALUES (?, ?) ON CONFLICT (path) DO NOTHING").run(path, harness);
  const row = sql.get("SELECT id, harness FROM logs WHERE path = ?").get(path);
  if (row === undefined) throw new Error(`log ${path} was not created`);
  if (row.harness !== harness) throw new Error(`log ${path} is a ${String(row.harness)} log, not ${harness}`);
  const id = Number(row.id);
  const one = (query: string, ...params: SqlValue[]) => sql.get(query).get(id, ...params);
  const all = (query: string, ...params: SqlValue[]) => sql.get(query).all(id, ...params);

  const content = (hash: string): JsonValue => {
    const r = sql.get("SELECT content FROM blocks WHERE hash = ?").get(hash);
    if (r === undefined) throw new Error(`the store has no content for block ${hash}`);
    return json(r.content);
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
      const r = one(
        "SELECT b.* FROM log_blocks l JOIN blocks b ON b.hash = l.hash WHERE l.log = ? AND l.hash = ?",
        hash,
      );
      return r === undefined ? undefined : block(r);
    },
    call(callId): Call | undefined {
      const r = one("SELECT * FROM calls WHERE log = ? AND id = ?", callId);
      return r === undefined ? undefined : call(r);
    },
    toolCall(toolCallId): ToolCall | undefined {
      const r = one("SELECT * FROM tool_calls WHERE log = ? AND id = ?", toolCallId);
      return r === undefined ? undefined : toolCall(r);
    },
    openRuns(sessionId, lane): CallBlock[] {
      return all(
        "SELECT * FROM call_blocks WHERE log = ? AND session_id = ? AND lane = ? AND last_call IS NULL",
        sessionId,
        lane,
      ).map(run);
    },
  };

  /** Insert content once: a hash already stored is not serialised again. */
  const ensureContent = (list: readonly ContentPart[]): string => {
    for (const part of list) {
      if (sql.get("SELECT 1 FROM blocks WHERE hash = ?").get(part.hash) !== undefined) continue;
      sql.get("INSERT INTO blocks (hash, content) VALUES (?, ?)").run(part.hash, JSON.stringify(part.content));
    }
    return JSON.stringify(list.map((p) => p.hash));
  };

  const apply = (delta: SessionDelta, result: Map<string, { added: string[]; updated: string[] }>) => {
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
      const known = sql.get("SELECT kind FROM blocks WHERE hash = ?").get(b.hash);
      if (known === undefined || known.kind === null)
        sql.get(UPSERT_BLOCK).run(...blockRow(b, JSON.stringify(b.content)));
      sql.get("INSERT INTO log_blocks (log, hash) VALUES (?, ?) ON CONFLICT DO NOTHING").run(id, b.hash);
    }
    for (const s of delta.sessions) sql.get(UPSERT_SESSION).run(id, ...sessionRow(s));
    for (const c of delta.calls) {
      const isNew = one("SELECT 1 FROM calls WHERE log = ? AND id = ?", c.id) === undefined;
      sql.get(UPSERT_CALL).run(id, ...callRow(c));
      const entry = result.get(c.sessionId) ?? { added: [], updated: [] };
      result.set(c.sessionId, entry);
      if (isNew) entry.added.push(c.id);
      else if (!entry.added.includes(c.id) && !entry.updated.includes(c.id)) entry.updated.push(c.id);
    }
    for (const r of delta.callBlocks) sql.get(UPSERT_RUN).run(id, ...runRow(r));
    for (const t of delta.toolCalls) sql.get(UPSERT_TOOL_CALL).run(id, ...toolCallRow(t));
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
    lookup,
    snapshot() {
      const r = sql.get("SELECT snapshot FROM logs WHERE id = ?").get(id);
      return r?.snapshot === null || r === undefined ? undefined : json(r.snapshot);
    },
    files: () => all("SELECT * FROM ingest_files WHERE log = ? ORDER BY path").map(fileMark),
    write(batch) {
      return db.transaction(() => {
        const result = new Map<string, { added: string[]; updated: string[] }>();
        for (const delta of batch.deltas) apply(delta, result);
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
        return { calls: [...result].map(([sessionId, calls]) => ({ sessionId, ...calls })) };
      });
    },
    reset() {
      db.transaction(() => {
        sql.get("DELETE FROM logs WHERE id = ?").run(id);
        sql.get("INSERT INTO logs (id, path, harness) VALUES (?, ?, ?)").run(id, path, harness);
      });
    },
    graph(): SessionGraph {
      const rows = (table: string) => all(`SELECT * FROM ${table} WHERE log = ? ORDER BY rowid`);
      const kinds = (status: string) =>
        all("SELECT kind, count FROM report_kinds WHERE log = ? AND status = ? ORDER BY seq", status).map((r) => ({
          kind: String(r.kind),
          count: Number(r.count),
        }));
      const blocks = all(
        "SELECT b.* FROM log_blocks l JOIN blocks b ON b.hash = l.hash WHERE l.log = ? ORDER BY b.rowid",
      );
      return {
        sessions: rows("sessions").map(session),
        calls: rows("calls").map(call),
        blocks: blocks.map(block),
        callBlocks: rows("call_blocks").map(run),
        toolCalls: rows("tool_calls").map(toolCall),
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
