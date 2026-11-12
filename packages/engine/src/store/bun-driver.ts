/** The `bun:sqlite` adapter of the SQL driver. */
import { Database } from "bun:sqlite";
import type { RawDatabase, SqlRow, SqlValue } from "./driver.ts";

export function openBun(path: string): RawDatabase {
  const db = new Database(path, { create: true });
  return {
    runtime: "bun",
    exec: (sql) => db.exec(sql),
    prepare(sql) {
      const statement = db.prepare(sql);
      return {
        run: (...params: SqlValue[]) => ({ changes: statement.run(...params).changes }),
        get: (...params: SqlValue[]) => (statement.get(...params) as SqlRow | null) ?? undefined,
        all: (...params: SqlValue[]) => statement.all(...params) as SqlRow[],
      };
    },
    inTransaction: () => db.inTransaction,
    close: () => db.close(),
  };
}
