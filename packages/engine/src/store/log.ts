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
/** A run is one Block at one position from its first Call on: that is its key (its id is made of the same parts). */
const UPSERT_RUN = upsertSql("call_blocks", RUN_COLUMNS, ["session_id", "lane", "first_call", "position"]);
const UPSERT_TOOL_CALL = upsertSql("tool_calls", TOOL_CALL_COLUMNS);
const UPSERT_COMPACTION = upsertSql("compactions", COMPACTION_COLUMNS);
const UPSERT_EVENT = upsertSql("session_events", EVENT_COLUMNS);
const UPSERT_MESSAGE = upsertSql("messages", ["key", "role", "blocks"], ["key"]);
const UPSERT_SHAPE = upsertSql("shapes", ["key", "tools", "system"], ["key"]);
const UPSERT_RECORD = upsertSql("records", ["key", "value"], ["key"]);
const UPSERT_LOG_BLOCK = upsertSql("log_blocks", LOG_BLOCK_COLUMNS, ["hash"]);
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
  const reset = () =>
    db.transaction(() => {
      sql.get("DELETE FROM logs WHERE id = ?").run(id);
      sql
        .get("INSERT INTO logs (id, path, harness, adapter_version) VALUES (?, ?, ?, ?)")
        .run(id, path, harness, codec.version);
    });
  // Another adapter version read this log differently: empty it, so that ingest reads it again from the start.
  if (Number(row.adapter_version) !== codec.version) reset();
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
      putContent(b.hash, b.content);
      sql.get(UPSERT_LOG_BLOCK).run(id, ...logBlockRow(b));
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
