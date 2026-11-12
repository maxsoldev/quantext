/** The `bun:sqlite` adapter of the SQL driver. */
import type { Database } from "bun:sqlite";
import type { RawDatabase, RawOptions, SqlRow, SqlValue } from "./driver.ts";

/** The module is passed in, not imported, so that a bundle loads `bun:sqlite` only on Bun (`driver.ts`). */
export type BunSqlite = { Database: typeof Database };

export function openBun({ Database }: BunSqlite, path: string, options: RawOptions = {}): RawDatabase {
  const db = new Database(path, options.readOnly === true ? { readonly: true } : { create: true });
  return {
    runtime: "bun",
    exec: (sql) => db.exec(sql),
    prepare(sql) {
      const statement = db.prepare(sql);
      return {
        run: (...params: SqlValue[]) => ({ changes: statement.run(...params).changes }),
        get: (...params: SqlValue[]) => (statement.get(...params) as SqlRow | null) ?? undefined,
        all: (...params: SqlValue[]) => statement.all(...params) as SqlRow[],
        iterate: (...params: SqlValue[]) => statement.iterate(...params) as IterableIterator<SqlRow>,
        columns: () => [...statement.columnNames],
      };
    },
    inTransaction: () => db.inTransaction,
    denyAllButReads: () => false, // bun:sqlite has no authorizer
    close: () => db.close(),
  };
}
