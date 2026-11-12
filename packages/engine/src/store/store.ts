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

export interface OpenStoreOptions {
  /** The folder of the database (`quantext.db`) and the writer lock (`writer.lock`); created when missing. */
  dataDir: string;
}

export interface Store {
  readonly path: string;
  readonly schemaVersion: number;
  /** The database, for reads by the query layer and tests. Writes go through the store's own methods. */
  readonly db: SqlDriver;
  /** The log of one main transcript (by path), created when new. `codec` maps the adapter's records to rows. */
  log(path: string, harness: string, codec: RecordCodec): LogStore;
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
