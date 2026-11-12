/** The `node:sqlite` adapter of the SQL driver. */
import { DatabaseSync } from "node:sqlite";
import type { RawDatabase, RawOptions, SqlRow, SqlValue } from "./driver.ts";

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
    close: () => db.close(),
  };
}
