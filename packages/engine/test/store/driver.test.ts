import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { SqlDriver } from "../../src/store/driver.ts";
import { openDriver } from "../../src/store/driver.ts";

const dirs: string[] = [];
const drivers: SqlDriver[] = [];

async function open(): Promise<SqlDriver> {
  const dir = mkdtempSync(join(tmpdir(), "qx-driver-"));
  dirs.push(dir);
  const db = await openDriver(join(dir, "test.db"));
  drivers.push(db);
  return db;
}

afterEach(() => {
  for (const db of drivers.splice(0)) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("the SQL driver", () => {
  test("is the built-in SQLite module of the runtime it runs on", async () => {
    const db = await open();
    expect(db.runtime).toBe(process.versions.bun === undefined ? "node" : "bun");
  });

  test("opens the database in WAL mode, with foreign keys and a busy timeout", async () => {
    const db = await open();
    expect(db.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
    expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    expect(db.prepare("PRAGMA busy_timeout").get()).toEqual({ timeout: 5000 });
  });

  test("runs prepared statements with positional parameters and gives rows back as plain objects", async () => {
    const db = await open();
    db.exec("CREATE TABLE t (i INTEGER, r REAL, s TEXT, n TEXT)");
    const insert = db.prepare("INSERT INTO t VALUES (?, ?, ?, ?)");
    expect(insert.run(1, 0.5, "a", null)).toEqual({ changes: 1 });
    insert.run(2, 1.25, "b", null);
    expect(db.prepare("SELECT * FROM t WHERE i = ?").get(2)).toEqual({ i: 2, r: 1.25, s: "b", n: null });
    expect(db.prepare("SELECT * FROM t WHERE i = ?").get(3)).toBeUndefined();
    expect(db.prepare("SELECT i FROM t ORDER BY i").all()).toEqual([{ i: 1 }, { i: 2 }]);
  });

  test("keeps the writes of a transaction only when it commits", async () => {
    const db = await open();
    db.exec("CREATE TABLE t (i INTEGER PRIMARY KEY)");
    db.transaction(() => db.prepare("INSERT INTO t VALUES (1)").run());
    expect(() =>
      db.transaction(() => {
        db.prepare("INSERT INTO t VALUES (2)").run();
        db.prepare("INSERT INTO t VALUES (1)").run();
      }),
    ).toThrow();
    expect(db.prepare("SELECT i FROM t").all()).toEqual([{ i: 1 }]);
  });

  test("rethrows the original error when SQLite already ended the transaction (as after SQLITE_FULL)", async () => {
    const db = await open();
    db.exec("CREATE TABLE t (i INTEGER)");
    expect(() =>
      db.transaction(() => {
        db.prepare("INSERT INTO t VALUES (1)").run();
        db.exec("ROLLBACK"); // what SQLite does by itself on some errors
        throw new Error("database or disk is full");
      }),
    ).toThrow("database or disk is full");
    db.transaction(() => db.prepare("INSERT INTO t VALUES (2)").run());
    expect(db.prepare("SELECT i FROM t").all()).toEqual([{ i: 2 }]);
  });

  test("returns the value of the transaction's function", async () => {
    const db = await open();
    expect(db.transaction(() => 42)).toBe(42);
  });
});
