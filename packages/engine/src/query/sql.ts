/**
 * Read-only SQL for agents (`qx sql`): one read statement, at most `limit` rows. Three guards: this check of the
 * text, a connection opened read-only, and `query_only`. There is no time limit: neither `node:sqlite` nor
 * `bun:sqlite` has an interrupt or a progress handler (docs/schema.md "Views").
 */
import type { JsonValue, SqlResult } from "@quantext/shared";
import type { SqlDriver, SqlValue } from "../store/index.ts";

export const DEFAULT_SQL_LIMIT = 1000;

/** The statement is not a single read: nothing was run. */
export class SqlRejectedError extends Error {
  override name = "SqlRejectedError";
}

const FIRST_WORDS = new Set(["SELECT", "WITH", "VALUES", "EXPLAIN"]);

/** Words that start a write, a schema change, a transaction or a change to the connection. */
const FORBIDDEN = new Set([
  "INSERT",
  "UPDATE",
  "DELETE",
  "REPLACE",
  "UPSERT",
  "CREATE",
  "DROP",
  "ALTER",
  "ATTACH",
  "DETACH",
  "PRAGMA",
  "VACUUM",
  "REINDEX",
  "ANALYZE",
  "BEGIN",
  "COMMIT",
  "END",
  "ROLLBACK",
  "SAVEPOINT",
  "RELEASE",
]);

/** Run one read statement; throws SqlRejectedError for anything else, or the driver's error. */
export function runSql(db: SqlDriver, sql: string, options: { limit?: number } = {}): SqlResult {
  checkReadOnly(sql);
  const limit = options.limit ?? DEFAULT_SQL_LIMIT;
  const statement = db.prepare(sql);
  const rows: SqlResult["rows"] = [];
  let truncated = false;
  for (const row of statement.iterate()) {
    if (rows.length >= limit) {
      truncated = true;
      break;
    }
    const out: { [column: string]: JsonValue } = {};
    for (const [column, value] of Object.entries(row)) out[column] = shown(value);
    rows.push(out);
  }
  return { columns: statement.columns(), rows, truncated };
}

/** Throw unless `sql` is one statement that starts as a read and holds no word of a write. */
export function checkReadOnly(sql: string): void {
  const code = codeOnly(sql);
  const statements = code.split(";").filter((s) => s.trim() !== "");
  if (statements.length !== 1) {
    throw new SqlRejectedError(statements.length === 0 ? "no statement" : "only one statement is allowed");
  }
  const words = [...(statements[0] ?? "").matchAll(/[A-Za-z_][A-Za-z0-9_$]*/g)];
  const first = words[0]?.[0].toUpperCase() ?? "";
  if (!FIRST_WORDS.has(first))
    throw new SqlRejectedError(`only a read is allowed (SELECT, WITH, VALUES), not ${first}`);
  for (const m of words) {
    const word = m[0].toUpperCase();
    // replace(x, y, z) is a function; END closes CASE.
    const call = /^\s*\(/.test(code.slice((m.index ?? 0) + m[0].length));
    if (word === "REPLACE" && call) continue;
    if (word === "END") continue;
    if (FORBIDDEN.has(word)) throw new SqlRejectedError(`${word} is not allowed: the store is read-only`);
  }
}

/**
 * The SQL with comments, string literals and quoted names blanked out (same length), so that only code is left to
 * check: a `;` or a keyword inside quotes is not code.
 */
function codeOnly(sql: string): string {
  let out = "";
  let i = 0;
  const blank = (to: number) => {
    out += " ".repeat(to - i);
    i = to;
  };
  const closing: Record<string, string> = { "'": "'", '"': '"', "`": "`", "[": "]" };
  while (i < sql.length) {
    const c = sql[i] ?? "";
    if (c === "-" && sql[i + 1] === "-") {
      const end = sql.indexOf("\n", i);
      blank(end === -1 ? sql.length : end);
    } else if (c === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      blank(end === -1 ? sql.length : end + 2);
    } else if (closing[c] !== undefined) {
      const close = closing[c] ?? c;
      let end = i + 1;
      for (;;) {
        const at = sql.indexOf(close, end);
        if (at === -1) {
          end = sql.length;
          break;
        }
        if (close !== "]" && sql[at + 1] === close) {
          end = at + 2; // a doubled quote is part of the literal
          continue;
        }
        end = at + 1;
        break;
      }
      // A quoted name stays a word, so that the check does not see a keyword in it.
      out += c === "'" ? " ".repeat(end - i) : `q${" ".repeat(end - i - 1)}`;
      i = end;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** A SQL value as JSON: a BLOB by its size, a big integer as a number when it fits, else as text. */
function shown(value: SqlValue | undefined): JsonValue {
  if (value === undefined || value === null) return null;
  if (value instanceof Uint8Array) return `<blob ${value.byteLength} bytes>`;
  if (typeof value === "bigint") return Number.isSafeInteger(Number(value)) ? Number(value) : String(value);
  return value;
}
