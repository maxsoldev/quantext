import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { Store } from "../../src/store/index.ts";
import { openDriver, openStore, SCHEMA_VERSION, StoreLockedError } from "../../src/store/index.ts";
import { onCleanup, tempDir } from "./temp.ts";

async function open(dataDir: string): Promise<Store> {
  const store = await openStore({ dataDir });
  onCleanup(() => store.close());
  return store;
}

const tables = (store: Store) =>
  store.db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((r) => r.name);

describe("opening the store", () => {
  test("creates the database in the data folder and migrates an empty one to the current schema", async () => {
    const dir = tempDir();
    const store = await open(join(dir, "data"));
    expect(existsSync(join(dir, "data", "quantext.db"))).toBe(true);
    expect(store.schemaVersion).toBe(SCHEMA_VERSION);
    expect(tables(store)).toEqual([
      "blocks",
      "call_blocks",
      "calls",
      "compactions",
      "ingest_files",
      "log_blocks",
      "logs",
      "messages",
      "records",
      "report_unknown",
      "report_unreadable",
      "schema_version",
      "sessions",
      "shapes",
      "tool_calls",
    ]);
  });

  test("keeps the schema and its data when opened again", async () => {
    const dir = tempDir();
    const first = await openStore({ dataDir: dir });
    first.db.prepare("INSERT INTO logs (path, harness) VALUES (?, ?)").run("/a.jsonl", "claude-code");
    first.close();
    const again = await open(dir);
    expect(again.schemaVersion).toBe(SCHEMA_VERSION);
    expect(again.db.prepare("SELECT path FROM logs").all()).toEqual([{ path: "/a.jsonl" }]);
  });

  test("refuses a database from a newer engine instead of changing it", async () => {
    const dir = tempDir();
    const db = await openDriver(join(dir, "quantext.db"));
    db.exec("CREATE TABLE schema_version (version INTEGER NOT NULL); INSERT INTO schema_version VALUES (99)");
    db.close();
    await expect(openStore({ dataDir: dir })).rejects.toThrow(/schema version 99 is newer than this engine/);
  });

  test("finds 'context at call N' through the interval index on the runs", async () => {
    const store = await open(tempDir());
    const plan = store.db
      .prepare(
        `EXPLAIN QUERY PLAN SELECT * FROM call_blocks
         WHERE log = ? AND session_id = ? AND lane = ? AND first_call <= ? AND (last_call IS NULL OR last_call >= ?)`,
      )
      .all(1, "s", "l", 5, 5)
      .map((r) => String(r.detail));
    expect(plan.join("\n")).toMatch(/USING (COVERING )?INDEX call_blocks_interval/);
  });
});

describe("the writer lock", () => {
  test("lets only one store write to a data folder at a time", async () => {
    const dir = tempDir();
    await open(dir);
    await expect(openStore({ dataDir: dir })).rejects.toThrow(StoreLockedError);
  });

  test("is released on close", async () => {
    const dir = tempDir();
    (await openStore({ dataDir: dir })).close();
    expect(existsSync(join(dir, "writer.lock"))).toBe(false);
    await open(dir);
  });

  test("names the process that holds it", async () => {
    const dir = tempDir();
    await open(dir);
    const error = await openStore({ dataDir: dir }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StoreLockedError);
    expect((error as StoreLockedError).pid).toBe(process.pid);
  });

  test("is taken over when the process that held it is gone", async () => {
    const dir = tempDir();
    const deadPid = 2 ** 22 + 12345; // above every platform's pid limit, so never a running process
    writeFileSync(join(dir, "writer.lock"), JSON.stringify({ pid: deadPid, token: "old" }));
    await open(dir);
    expect(JSON.parse(readFileSync(join(dir, "writer.lock"), "utf8")).pid).toBe(process.pid);
  });

  test("is taken over when the lock file is not readable as a lock", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "writer.lock"), "not json");
    await open(dir);
    expect(JSON.parse(readFileSync(join(dir, "writer.lock"), "utf8")).pid).toBe(process.pid);
  });
});
