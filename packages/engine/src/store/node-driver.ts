/** The `node:sqlite` adapter of the SQL driver. */
import { DatabaseSync } from "node:sqlite";
import type { RawDatabase, SqlRow, SqlValue } from "./driver.ts";

export function openNode(path: string): RawDatabase {
  const db = new DatabaseSync(path);
  return {
    runtime: "node",
    exec: (sql) => db.exec(sql),
    prepare(sql) {
      const statement = db.prepare(sql);
      return {
        run: (...params: SqlValue[]) => ({ changes: Number(statement.run(...params).changes) }),
        get: (...params: SqlValue[]) => statement.get(...params) as SqlRow | undefined,
        all: (...params: SqlValue[]) => statement.all(...params) as SqlRow[],
      };
    },
    inTransaction: () => db.isTransaction,
    close: () => db.close(),
  };
}
