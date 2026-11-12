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
  /** The rows one at a time, so that a caller can stop early without reading the rest. */
  iterate(...params: SqlValue[]): IterableIterator<SqlRow>;
  /** The names of the result columns, in order (empty for a statement that returns no rows). */
  columns(): string[];
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
  /**
   * Let SQLite deny every later statement that does more than read (an authorizer); false when the runtime's SQLite
   * module has no authorizer (`bun:sqlite`, `node:sqlite` before Node 24).
   */
  denyAllButReads(): boolean;
  close(): void;
}

export interface RawOptions {
  /** Open the file read-only (SQLITE_OPEN_READONLY): it must exist, and no write can reach it. */
  readOnly?: boolean;
}

/** Open (or create) a database file with the runtime's built-in SQLite, with no settings changed. */
export async function openRaw(path: string, options: RawOptions = {}): Promise<RawDatabase> {
  return process.versions.bun === undefined
    ? (await import("./node-driver.ts")).openNode(path, options)
    : (await import("./bun-driver.ts")).openBun(path, options);
}

/**
 * Open an existing database file read-only: the file is opened read-only, `setup` runs (temporary views), and then
 * `query_only` stops every write, also to the temporary schema. Writes still fail inside `transaction`.
 */
export async function openReadOnlyDriver(
  path: string,
  setup?: (db: SqlDriver) => void,
  readsOnly = false,
): Promise<SqlDriver> {
  const raw = await openRaw(path, { readOnly: true });
  try {
    raw.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    const db = withTransactions(raw);
    setup?.(db);
    raw.exec("PRAGMA query_only = 1");
    if (readsOnly) raw.denyAllButReads();
    return db;
  } catch (error) {
    raw.close();
    throw error;
  }
}

/** Whether `denyAllButReads` works on this runtime: its SQLite module has an authorizer. */
export async function readsOnlyEnforced(): Promise<boolean> {
  return process.versions.bun === undefined && (await import("./node-driver.ts")).hasAuthorizer();
}

/** Open (or create) the database file with the runtime's built-in SQLite: WAL, foreign keys, a busy timeout. */
export async function openDriver(path: string): Promise<SqlDriver> {
  const raw = await openRaw(path);
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
