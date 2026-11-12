import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { openReader, openStore, SCHEMA_VERSION } from "../../src/store/index.ts";
import { onCleanup, tempDir } from "./temp.ts";

async function written(): Promise<string> {
  const dataDir = tempDir();
  const store = await openStore({ dataDir });
  store.db.exec("CREATE TABLE IF NOT EXISTS t (i INTEGER); INSERT INTO t VALUES (1), (2), (3)");
  store.close();
  return dataDir;
}

describe("the read-only reader", () => {
  test("reads a store that no engine holds open", async () => {
    const reader = await openReader(await written());
    onCleanup(() => reader.close());
    expect(reader.prepare("SELECT count(*) AS n FROM t").get()).toEqual({ n: 3 });
  });

  test("reads while the writer holds the store open, and sees its commits", async () => {
    const dataDir = await written();
    const store = await openStore({ dataDir });
    onCleanup(() => store.close());
    const reader = await openReader(dataDir);
    onCleanup(() => reader.close());
    store.db.exec("INSERT INTO t VALUES (4)");
    expect(reader.prepare("SELECT count(*) AS n FROM t").get()).toEqual({ n: 4 });
  });

  test("cannot write, not even a temporary table", async () => {
    const reader = await openReader(await written());
    onCleanup(() => reader.close());
    expect(() => reader.exec("INSERT INTO t VALUES (9)")).toThrow();
    expect(() => reader.exec("CREATE TEMP TABLE x (i INTEGER)")).toThrow();
    expect(() => reader.exec("PRAGMA user_version = 3")).toThrow();
    expect(reader.prepare("SELECT count(*) AS n FROM t").get()).toEqual({ n: 3 });
  });

  test("runs setup on the connection before it becomes read-only", async () => {
    const reader = await openReader(await written(), {
      setup: (db) => db.exec("CREATE TEMP VIEW v AS SELECT i * 10 AS x FROM t"),
    });
    onCleanup(() => reader.close());
    expect(reader.prepare("SELECT x FROM v ORDER BY x").all()).toEqual([{ x: 10 }, { x: 20 }, { x: 30 }]);
    expect(() => reader.exec("DROP VIEW v")).toThrow();
  });

  test("refuses a folder with no store, and a store of another schema version", async () => {
    await expect(openReader(join(tempDir(), "none"))).rejects.toThrow(/no store/);
    const dataDir = await written();
    const store = await openStore({ dataDir });
    store.db.exec(`UPDATE schema_version SET version = ${SCHEMA_VERSION + 1}`);
    store.close();
    await expect(openReader(dataDir)).rejects.toThrow(/schema version/);
  });

  test("iterates rows lazily and names the columns of a statement", async () => {
    const reader = await openReader(await written());
    onCleanup(() => reader.close());
    const statement = reader.prepare("SELECT i, i * 2 AS twice FROM t ORDER BY i");
    expect(statement.columns()).toEqual(["i", "twice"]);
    const first: unknown[] = [];
    for (const row of statement.iterate()) {
      first.push(row);
      break;
    }
    expect(first).toEqual([{ i: 1, twice: 2 }]);
  });
});
