/** The store: one SQLite database in the data folder, written by one engine at a time. */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { RecordCodec } from "@quantext/shared";
import type { SqlDriver } from "./driver.ts";
import { openDriver } from "./driver.ts";
import { acquireLock } from "./lock.ts";
import type { LogStore } from "./log.ts";
import { openLog } from "./log.ts";
import { migrate } from "./schema.ts";
import { Statements } from "./statements.ts";

/** The default data folder, `~/.quantext`: outside the plugin folder, which an uninstall deletes. */
export function defaultDataDir(home: string): string {
  return join(home, ".quantext");
}

export interface OpenStoreOptions {
  /** The folder of the database (`quantext.db`) and the writer lock (`writer.lock`); created when missing. */
  dataDir: string;
}

export interface StoreReport {
  /** Unknown record kinds with their counts, summed over logs, most frequent first. */
  unknownRecords: { kind: string; count: number }[];
  /** Records that could not be read, by log (the main transcript's path) and place. */
  unreadable: { log: string; at: string; reason: string }[];
  /** Files that could not be read, or whose log failed to ingest, and why. */
  errors: { path: string; error: string }[];
  /** Files whose last bytes are not a complete line yet: held back until the newline comes. */
  files: { path: string; pendingBytes: number }[];
}

export interface Store {
  readonly path: string;
  readonly schemaVersion: number;
  /** The database, for reads by the query layer and tests. Writes go through the store's own methods. */
  readonly db: SqlDriver;
  /** The log of one main transcript (by path), created when new. `codec` maps the adapter's records to rows. */
  log(path: string, harness: string, codec: RecordCodec): LogStore;
  /** What could not be read, over all logs: the report rows, file errors, and lines still being written. */
  report(): StoreReport;
  /** The paths of every log in the store, oldest first. */
  logs(): string[];
  close(): void;
}

/** Open the store for writing: take the writer lock, open the database, migrate it to the current schema. */
export async function openStore(options: OpenStoreOptions): Promise<Store> {
  mkdirSync(options.dataDir, { recursive: true });
  const lock = acquireLock(join(options.dataDir, "writer.lock"));
  const path = join(options.dataDir, "quantext.db");
  let db: SqlDriver | undefined;
  try {
    db = await openDriver(path);
    const schemaVersion = migrate(db);
    const opened = db;
    const sql = new Statements(opened);
    return {
      path,
      schemaVersion,
      db: opened,
      log: (logPath, harness, codec) => openLog(opened, sql, logPath, harness, codec),
      report: () => ({
        unknownRecords: sql
          .get("SELECT kind, sum(count) AS count FROM report_unknown GROUP BY kind ORDER BY count DESC, kind")
          .all()
          .map((r) => ({ kind: String(r.kind), count: Number(r.count) })),
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
      }),
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
