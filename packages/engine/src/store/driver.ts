/**
 * The one seam between the store and SQLite (ADR 3): what both `node:sqlite` and `bun:sqlite` support, and no more.
 * The runtime picks the adapter; nothing above this file knows which one runs.
 */

/** A value SQLite takes as a parameter or gives back in a row. */
export type SqlValue = string | number | bigint | null | Uint8Array;
export type SqlRow = Record<string, SqlValue>;

export interface SqlStatement {
  run(...params: SqlValue[]): { changes: number };
  /** The first row, or undefined when there is none. */
  get(...params: SqlValue[]): SqlRow | undefined;
  all(...params: SqlValue[]): SqlRow[];
}

export interface SqlDriver {
  readonly runtime: "node" | "bun";
  exec(sql: string): void;
  prepare(sql: string): SqlStatement;
  /** Run `work` in one write transaction (BEGIN IMMEDIATE): all its writes are kept, or none if it throws. */
  transaction<T>(work: () => T): T;
  close(): void;
}

export const BUSY_TIMEOUT_MS = 5000;

/** The raw database of one runtime, before the shared settings and the transaction helper are added. */
export interface RawDatabase {
  runtime: SqlDriver["runtime"];
  exec(sql: string): void;
  prepare(sql: string): SqlStatement;
  /** Whether a transaction is open: SQLite ends one by itself on some errors (SQLITE_FULL, SQLITE_IOERR). */
  inTransaction(): boolean;
  close(): void;
}

/** Open (or create) the database file with the runtime's built-in SQLite: WAL, foreign keys, a busy timeout. */
export async function openDriver(path: string): Promise<SqlDriver> {
  const raw =
    process.versions.bun === undefined
      ? (await import("./node-driver.ts")).openNode(path)
      : (await import("./bun-driver.ts")).openBun(path);
  raw.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  raw.exec("PRAGMA journal_mode = WAL");
  raw.exec("PRAGMA synchronous = NORMAL");
  raw.exec("PRAGMA foreign_keys = ON");
  return withTransactions(raw);
}

function withTransactions(raw: RawDatabase): SqlDriver {
  let open = false;
  return {
    runtime: raw.runtime,
    exec: (sql) => raw.exec(sql),
    prepare: (sql) => raw.prepare(sql),
    close: () => raw.close(),
    transaction<T>(work: () => T): T {
      if (open) throw new Error("transactions do not nest");
      open = true;
      raw.exec("BEGIN IMMEDIATE");
      try {
        const result = work();
        raw.exec("COMMIT");
        return result;
      } catch (error) {
        if (raw.inTransaction()) {
          try {
            raw.exec("ROLLBACK");
          } catch (rollback) {
            throw new AggregateError([error, rollback], `rollback failed after: ${String(error)}`);
          }
        }
        throw error;
      } finally {
        open = false;
      }
    },
  };
}
