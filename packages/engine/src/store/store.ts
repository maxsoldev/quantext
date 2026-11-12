/** The store: one SQLite database in the data folder, written by one engine at a time. */
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { MemoryDocument, MemoryMark, RequestLog, StoreCodec } from "@quantext/shared";
import type { SqlDriver } from "./driver.ts";
import { openDriver, openReadOnlyDriver } from "./driver.ts";
import { acquireLock } from "./lock.ts";
import type { LogStore } from "./log.ts";
import { openLog } from "./log.ts";
import { migrate, SCHEMA_VERSION } from "./schema.ts";
import { Statements } from "./statements.ts";

/** The default data folder, `~/.quantext`: outside the plugin folder, which an uninstall deletes. */
export function defaultDataDir(home: string): string {
  return join(home, ".quantext");
}

export interface OpenStoreOptions {
  /** The folder of the database (`quantext.db`) and the writer lock (`writer.lock`, `writer.pid`); created when missing. */
  dataDir: string;
}

export interface StoreReport {
  /** Unknown record kinds with their counts, summed over logs, most frequent first. */
  unknownRecords: { kind: string; count: number }[];
  /** Known record kinds that hold nothing for the domain, with their counts, most frequent first. */
  ignoredRecords: { kind: string; count: number }[];
  /** Records that could not be read, by log (the main transcript's path) and place. */
  unreadable: { log: string; at: string; reason: string }[];
  /** Files that could not be read, or whose log failed to ingest, and why. */
  errors: { path: string; error: string }[];
  /** Files whose last bytes are not a complete line yet: held back until the newline comes. */
  files: { path: string; pendingBytes: number }[];
  /** What the last scan of the transcript folder could not read or did not follow (folders, symbolic links). */
  scan: { path: string; issue: string }[];
  /** Sessions by whether the log holds their requests (`absent`: usage only, the context cannot be rebuilt). */
  requestLogs: { requestLog: RequestLog; sessions: number }[];
}

export interface MemoryStore {
  /** Every stored document's mark, by project folder and path. */
  marks(): MemoryMark[];
  /** Store new and changed documents and delete removed ones, in one transaction; returns the change cursor after. */
  write(changes: {
    put: readonly MemoryDocument[];
    remove: readonly Pick<MemoryMark, "projectDir" | "path">[];
  }): number;
}

export interface Store {
  readonly path: string;
  readonly schemaVersion: number;
  /** The database, for reads by the query layer and tests. Writes go through the store's own methods. */
  readonly db: SqlDriver;
  /** The log of one main transcript (by path), created when new. `codec` maps the adapter's records to rows. */
  log(path: string, harness: string, codec: StoreCodec): LogStore;
  /** What could not be read, over all logs: the report rows, file errors, and lines still being written. */
  report(): StoreReport;
  /** Replace what the last full scan of the transcript folder found it could not read or did not follow. */
  setScanIssues(issues: readonly { path: string; issue: string }[]): void;
  /** The project memory documents ingest has read, by project folder and path. */
  readonly memory: MemoryStore;
  /** The change cursor: it grows with each write that changes a Session (`WriteResult.cursor`). */
  changeCursor(): number;
  /** Each file's bytes read so far, by path: what ingest goes on from. */
  fileOffsets(): Map<string, number>;
  /** The paths of every log in the store, oldest first. */
  logs(): string[];
  close(): void;
}

/** Open the store for writing: take the writer lock, open the database, migrate it to the current schema. */
export async function openStore(options: OpenStoreOptions): Promise<Store> {
  // The store holds whole transcripts: a new data folder and its files are the user's alone.
  mkdirSync(options.dataDir, { recursive: true, mode: 0o700 });
  const lock = await acquireLock(join(options.dataDir, "writer.lock"), join(options.dataDir, "writer.pid"));
  const path = join(options.dataDir, "quantext.db");
  let db: SqlDriver | undefined;
  try {
    db = await openDriver(path);
    // SQLite gives its WAL and shared-memory files the database file's mode.
    if (process.platform !== "win32") chmodSync(path, 0o600);
    const schemaVersion = migrate(db);
    const opened = db;
    const sql = new Statements(opened);
    const kinds = (status: string) =>
      sql
        .get(
          `SELECT kind, sum(count) AS count FROM report_kinds WHERE status = ?
           GROUP BY kind ORDER BY count DESC, kind`,
        )
        .all(status)
        .map((r) => ({ kind: String(r.kind), count: Number(r.count) }));
    return {
      path,
      schemaVersion,
      db: opened,
      log: (logPath, harness, codec) => openLog(opened, sql, logPath, harness, codec),
      report: () => ({
        unknownRecords: kinds("unknown"),
        ignoredRecords: kinds("ignored"),
        unreadable: sql
          .get(
            `SELECT l.path, r.at, r.reason FROM report_unreadable r JOIN logs l ON l.id = r.log
             ORDER BY r.log, r.seq`,
          )
          .all()
          .map((r) => ({ log: String(r.path), at: String(r.at), reason: String(r.reason) })),
        errors: sql
          .get("SELECT path, error FROM ingest_files WHERE error IS NOT NULL ORDER BY path")
          .all()
          .map((r) => ({ path: String(r.path), error: String(r.error) })),
        files: sql
          .get(
            `SELECT path, size - byte_offset AS pending FROM ingest_files
             WHERE kind = 'transcript' AND error IS NULL AND size > byte_offset ORDER BY path`,
          )
          .all()
          .map((r) => ({ path: String(r.path), pendingBytes: Number(r.pending) })),
        scan: sql
          .get("SELECT path, issue FROM scan_issues ORDER BY path")
          .all()
          .map((r) => ({ path: String(r.path), issue: String(r.issue) })),
        requestLogs: sql
          .get("SELECT request_log, count(*) AS n FROM sessions GROUP BY request_log ORDER BY request_log")
          .all()
          .map((r) => ({ requestLog: String(r.request_log) as RequestLog, sessions: Number(r.n) })),
      }),
      setScanIssues(issues) {
        opened.transaction(() => {
          sql.get("DELETE FROM scan_issues").run();
          for (const { path: at, issue } of issues) {
            sql.get("INSERT INTO scan_issues (path, issue) VALUES (?, ?) ON CONFLICT DO NOTHING").run(at, issue);
          }
        });
      },
      memory: {
        marks: () =>
          sql
            .get("SELECT project_dir, path, mtime_ms, size FROM project_memory ORDER BY project_dir, path")
            .all()
            .map((r) => ({
              projectDir: String(r.project_dir),
              path: String(r.path),
              mtimeMs: Number(r.mtime_ms),
              size: Number(r.size),
            })),
        write: ({ put, remove }) =>
          opened.transaction(() => {
            for (const d of put) {
              sql
                .get(
                  `INSERT INTO project_memory (project_dir, path, content, mtime_ms, size) VALUES (?, ?, ?, ?, ?)
                   ON CONFLICT (project_dir, path) DO UPDATE SET content = excluded.content,
                     mtime_ms = excluded.mtime_ms, size = excluded.size`,
                )
                .run(d.projectDir, d.path, d.content, d.mtimeMs, d.size);
            }
            for (const d of remove) {
              sql.get("DELETE FROM project_memory WHERE project_dir = ? AND path = ?").run(d.projectDir, d.path);
            }
            sql.get("UPDATE change_cursor SET seq = seq + 1").run();
            return Number(sql.get("SELECT seq FROM change_cursor").get()?.seq);
          }),
      },
      changeCursor: () => Number(sql.get("SELECT seq FROM change_cursor").get()?.seq ?? 0),
      fileOffsets: () =>
        new Map(
          sql
            .get("SELECT path, byte_offset FROM ingest_files")
            .all()
            .map((r) => [String(r.path), Number(r.byte_offset)]),
        ),
      logs: () =>
        sql
          .get("SELECT path FROM logs ORDER BY id")
          .all()
          .map((r) => String(r.path)),
      close() {
        opened.close();
        lock.release();
      },
    };
  } catch (error) {
    db?.close();
    lock.release();
    throw error;
  }
}

export interface OpenReaderOptions {
  /** Runs on the connection before it becomes read-only: for temporary views. */
  setup?: (db: SqlDriver) => void;
  /** Also let SQLite deny every statement that does more than read, where the runtime can (`readsOnlyEnforced`). */
  readsOnly?: boolean;
}

/**
 * Open the store of a data folder read-only, with no writer lock: for the query layer and `qx sql`, also while an
 * engine writes. The file is opened read-only and `query_only` is set, so no statement can change it.
 */
export async function openReader(dataDir: string, options: OpenReaderOptions = {}): Promise<SqlDriver> {
  const path = join(dataDir, "quantext.db");
  if (!existsSync(path)) throw new Error(`there is no store in ${dataDir}: run \`qx ingest\` first`);
  return openReadOnlyDriver(
    path,
    (db) => {
      const version = Number(db.prepare("SELECT version FROM schema_version").get()?.version ?? 0);
      if (version !== SCHEMA_VERSION) {
        throw new Error(
          `the store's schema version is ${version}, this engine reads ${SCHEMA_VERSION}: run \`qx ingest\` to migrate it`,
        );
      }
      options.setup?.(db);
    },
    options.readsOnly === true,
  );
}
