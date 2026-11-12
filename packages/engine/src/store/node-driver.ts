/** The `node:sqlite` adapter of the SQL driver. */
import { DatabaseSync } from "node:sqlite";
import type { RawDatabase, RawOptions, SqlRow, SqlValue } from "./driver.ts";

/** SQLite's authorizer codes for reading (sqlite3.h): READ, SELECT, FUNCTION, RECURSIVE. */
const READ_ACTIONS = new Set([20, 21, 31, 33]);
const SQLITE_PRAGMA = 19;
/** Pragmas that only describe the schema, so an agent can discover it (`pragma_table_info('calls')`). */
const SCHEMA_PRAGMAS = new Set([
  "table_info",
  "table_xinfo",
  "table_list",
  "index_list",
  "index_info",
  "index_xinfo",
  "foreign_key_list",
]);
const SQLITE_OK = 0;
const SQLITE_DENY = 1;

/** The authorizer of `node:sqlite` (Node 24 and later); not in the Node 22 types. */
type WithAuthorizer = {
  setAuthorizer?: (callback: ((action: number, name: string | null) => number) | null) => void;
};

export function hasAuthorizer(): boolean {
  return typeof (DatabaseSync.prototype as unknown as WithAuthorizer).setAuthorizer === "function";
}

export function openNode(path: string, options: RawOptions = {}): RawDatabase {
  const db = new DatabaseSync(path, options.readOnly === true ? { readOnly: true } : {});
  return {
    runtime: "node",
    exec: (sql) => db.exec(sql),
    prepare(sql) {
      const statement = db.prepare(sql);
      return {
        run: (...params: SqlValue[]) => ({ changes: Number(statement.run(...params).changes) }),
        get: (...params: SqlValue[]) => statement.get(...params) as SqlRow | undefined,
        all: (...params: SqlValue[]) => statement.all(...params) as SqlRow[],
        iterate: (...params: SqlValue[]) => statement.iterate(...params) as IterableIterator<SqlRow>,
        columns: () => statement.columns().map((c) => c.name),
      };
    },
    inTransaction: () => db.isTransaction,
    denyAllButReads() {
      const set = (db as unknown as WithAuthorizer).setAuthorizer;
      if (typeof set !== "function") return false;
      set.call(db, (action, name) =>
        READ_ACTIONS.has(action) || (action === SQLITE_PRAGMA && SCHEMA_PRAGMAS.has(String(name).toLowerCase()))
          ? SQLITE_OK
          : SQLITE_DENY,
      );
      return true;
    },
    close: () => db.close(),
  };
}
