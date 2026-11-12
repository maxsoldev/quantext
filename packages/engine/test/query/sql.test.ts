import { describe, expect, test } from "vitest";
import { runSql, SqlRejectedError } from "../../src/query/index.ts";
import { ingested } from "./corpus.ts";

describe("read-only SQL for agents", () => {
  test("runs one SELECT and gives its columns and rows", async () => {
    const { db } = await ingested(["basic-tools"]);
    const result = runSql(db, "SELECT count(*) AS calls, min(idx) AS first FROM calls");
    expect(result).toEqual({ columns: ["calls", "first"], rows: [{ calls: 8, first: 0 }], truncated: false });
  });

  test("accepts WITH, VALUES, EXPLAIN and a trailing semicolon or comment", async () => {
    const { db } = await ingested(["basic-tools"]);
    expect(runSql(db, "WITH x AS (SELECT 1 AS a) SELECT a FROM x;").rows).toEqual([{ a: 1 }]);
    expect(runSql(db, "VALUES (1, 'a;b')").rows).toEqual([{ column1: 1, column2: "a;b" }]);
    expect(runSql(db, "SELECT 1 AS a -- the end; DROP TABLE calls").rows).toEqual([{ a: 1 }]);
    expect(runSql(db, "EXPLAIN QUERY PLAN SELECT * FROM calls").rows.length).toBeGreaterThan(0);
  });

  test("caps the rows and says so", async () => {
    const { db } = await ingested(["basic-tools"]);
    const result = runSql(db, "SELECT idx FROM calls ORDER BY idx", { limit: 3 });
    expect(result.rows).toEqual([{ idx: 0 }, { idx: 1 }, { idx: 2 }]);
    expect(result.truncated).toBe(true);
  });

  test.each([
    ["a write", "DELETE FROM calls"],
    ["a write in a CTE", "WITH x AS (SELECT 1) DELETE FROM calls"],
    ["an insert", "INSERT INTO scan_issues VALUES ('a', 'b')"],
    ["a schema change", "CREATE TABLE t (i INTEGER)"],
    ["a temporary table", "CREATE TEMP TABLE t AS SELECT 1"],
    ["ATTACH", "ATTACH DATABASE 'other.db' AS other"],
    ["DETACH", "DETACH DATABASE temp"],
    ["a PRAGMA write", "PRAGMA journal_mode = DELETE"],
    ["a PRAGMA read", "PRAGMA table_info(calls)"],
    ["a second statement", "SELECT 1; DELETE FROM calls"],
    ["two reads", "SELECT 1; SELECT 2"],
    ["a transaction", "BEGIN"],
    ["VACUUM", "VACUUM INTO 'copy.db'"],
    ["an empty statement", "  -- nothing\n"],
  ])("rejects %s", async (_, sql) => {
    const { db } = await ingested(["basic-tools"]);
    expect(() => runSql(db, sql)).toThrow(SqlRejectedError);
    expect(runSql(db, "SELECT count(*) AS n FROM calls").rows).toEqual([{ n: 8 }]);
  });

  test("a write that passes the check still fails on the read-only connection", async () => {
    const { db } = await ingested(["basic-tools"]);
    expect(() => db.exec("UPDATE calls SET idx = idx + 1")).toThrow();
  });

  test("shows a BLOB by its size, and text with semicolons and keywords as text", async () => {
    const { db } = await ingested(["basic-tools"]);
    const result = runSql(db, "SELECT x'00ff' AS b, 'DROP TABLE x; ATTACH' AS t, \"idx\" AS i FROM calls LIMIT 1");
    expect(result.rows).toEqual([{ b: "<blob 2 bytes>", t: "DROP TABLE x; ATTACH", i: 0 }]);
  });
});
