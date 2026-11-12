/** Prepared statements, made once per database and reused for every row. */
import type { SqlDriver, SqlStatement } from "./driver.ts";

export class Statements {
  private readonly db: SqlDriver;
  private readonly cache = new Map<string, SqlStatement>();

  constructor(db: SqlDriver) {
    this.db = db;
  }

  get(sql: string): SqlStatement {
    let statement = this.cache.get(sql);
    if (statement === undefined) {
      statement = this.db.prepare(sql);
      this.cache.set(sql, statement);
    }
    return statement;
  }
}

/** An insert of one row of a log's table that replaces the columns of the row with the same (log, key). */
export function upsertSql(table: string, columns: readonly string[], key: readonly string[] = ["id"]): string {
  const updates = columns.filter((c) => !key.includes(c)).map((c) => `${c} = excluded.${c}`);
  return `INSERT INTO ${table} (log, ${columns.join(", ")}) VALUES (?${", ?".repeat(columns.length)})
    ON CONFLICT (log, ${key.join(", ")}) DO UPDATE SET ${updates.join(", ")}`;
}
