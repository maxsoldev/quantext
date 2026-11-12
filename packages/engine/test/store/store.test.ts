import { spawn } from "node:child_process";
import { chmodSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
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
  test.skipIf(process.platform === "win32")("makes a new data folder and its files private to the user", async () => {
    const dataDir = join(tempDir("qx-parent-"), "new", ".quantext");
    const store = await openStore({ dataDir });
    store.db.exec("CREATE TABLE t (x)"); // the WAL files exist once written
    const mode = (path: string) => statSync(path).mode & 0o777;
    expect(mode(dataDir)).toBe(0o700);
    // SQLite makes its journal, WAL and shared-memory files with the mode of their database.
    const files = [
      "quantext.db",
      "quantext.db-wal",
      "quantext.db-shm",
      "writer.lock",
      "writer.lock-journal",
      "writer.pid",
    ];
    for (const name of files.filter((f) => existsSync(join(dataDir, f)))) {
      expect([name, mode(join(dataDir, name))]).toEqual([name, 0o600]);
    }
    expect(existsSync(join(dataDir, "quantext.db-wal"))).toBe(true);
    store.close();
  });

  test("creates the database in the data folder and migrates an empty one to the current schema", async () => {
    const dir = tempDir();
    const store = await open(join(dir, "data"));
    expect(existsSync(join(dir, "data", "quantext.db"))).toBe(true);
    expect(store.schemaVersion).toBe(SCHEMA_VERSION);
    expect(tables(store)).toEqual([
      "blocks",
      "call_blocks",
      "calls",
      "change_cursor",
      "compactions",
      "ingest_files",
      "log_blocks",
      "logs",
      "media",
      "messages",
      "project_memory",
      "records",
      "report_kinds",
      "report_unreadable",
      "scan_issues",
      "schema_version",
      "session_events",
      "sessions",
      "shapes",
      "tool_calls",
    ]);
  });

  test("keeps the schema and its data when opened again", async () => {
    const dir = tempDir();
    const first = await openStore({ dataDir: dir });
    first.db
      .prepare("INSERT INTO logs (path, harness, adapter_version) VALUES (?, ?, 1)")
      .run("/a.jsonl", "claude-code");
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

  test("finds the open runs of a lane through the runs' key, which is their interval", async () => {
    const store = await open(tempDir());
    const plan = store.db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT * FROM call_blocks WHERE log = ? AND session_id = ? AND lane = ? AND last_call IS NULL",
      )
      .all(1, "s", "l")
      .map((r) => String(r.detail));
    expect(plan.join("\n")).toMatch(/USING PRIMARY KEY \(log=\? AND session_id=\? AND lane=\?\)/);
  });

  test("finds 'context at call N' through the runs' key (log, session, lane, first call, position)", async () => {
    const store = await open(tempDir());
    const plan = store.db
      .prepare(
        `EXPLAIN QUERY PLAN SELECT * FROM call_blocks
         WHERE log = ? AND session_id = ? AND lane = ? AND first_call <= ? AND (last_call IS NULL OR last_call >= ?)`,
      )
      .all(1, "s", "l", 5, 5)
      .map((r) => String(r.detail));
    expect(plan.join("\n")).toMatch(/USING PRIMARY KEY \(log=\? AND session_id=\? AND lane=\? AND first_call<\?\)/);
  });
});

test("tables with a natural key have no rowid", async () => {
  const store = await open(tempDir());
  const without = store.db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND sql LIKE '%WITHOUT ROWID%' ORDER BY name")
    .all()
    .map((r) => r.name);
  expect(without).toEqual([
    "call_blocks",
    "calls",
    "compactions",
    "ingest_files",
    "log_blocks",
    "messages",
    "project_memory",
    "records",
    "report_kinds",
    "report_unreadable",
    "scan_issues",
    "session_events",
    "sessions",
    "shapes",
    "tool_calls",
  ]);
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
    expect(existsSync(join(dir, "writer.pid"))).toBe(false);
    await open(dir);
  });

  test("names the process that holds it", async () => {
    const dir = tempDir();
    await open(dir);
    const error = await openStore({ dataDir: dir }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StoreLockedError);
    expect((error as StoreLockedError).pid).toBe(process.pid);
  });

  test("does not depend on the pid: a pid file that names a running process does not block", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "writer.pid"), String(process.ppid)); // a running process that holds no lock
    await open(dir);
    expect(readFileSync(join(dir, "writer.pid"), "utf8")).toBe(String(process.pid));
  });

  test("replaces a lock file of an older engine that is not a lock database", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "writer.lock"), JSON.stringify({ pid: process.pid, token: "old" }));
    await open(dir);
  });

  test("is held by another process until it dies, also when it is killed", { timeout: 30_000 }, async () => {
    const dir = tempDir();
    const child = spawn(process.execPath, [join(import.meta.dirname, "hold-store.ts"), dir], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    onCleanup(() => {
      child.kill("SIGKILL");
    });
    await new Promise<void>((resolve, reject) => {
      child.stdout.on("data", (d: Buffer) => d.toString().includes("ready") && resolve());
      child.on("exit", (code) => reject(new Error(`the holder exited with ${code}`)));
    });
    const error = await openStore({ dataDir: dir }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StoreLockedError);
    expect((error as StoreLockedError).pid).toBe(child.pid);
    const exited = new Promise((resolve) => child.on("exit", resolve));
    child.kill("SIGKILL");
    await exited;
    await open(dir);
  });
});

describe("a quantext.db that is not a Quantext store", () => {
  /** A database another program made: its own tables, one with a name the store uses, no schema version. */
  async function foreign(dataDir: string, sql: string): Promise<string> {
    const path = join(dataDir, "quantext.db");
    const db = await openDriver(path);
    db.exec(sql);
    db.exec("PRAGMA journal_mode = DELETE");
    db.close();
    chmodSync(path, 0o644);
    return path;
  }

  test.each([
    ["no schema version", "CREATE TABLE ingest_files (path TEXT); CREATE TABLE spans (id INTEGER)"],
    [
      "a schema version of its own",
      "CREATE TABLE schema_version (version INTEGER); INSERT INTO schema_version VALUES (2); CREATE TABLE ingest_files (path TEXT)",
    ],
  ])("with %s is refused by name and left as it was", async (_, sql) => {
    const dataDir = tempDir();
    const path = await foreign(dataDir, sql);
    const before = { bytes: readFileSync(path), mode: statSync(path).mode, mtime: statSync(path).mtimeMs };
    const error = await openStore({ dataDir }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(String((error as Error).message)).toContain(path);
    expect(String((error as Error).message)).toContain("move it aside");
    expect({ bytes: readFileSync(path), mode: statSync(path).mode, mtime: statSync(path).mtimeMs }).toEqual(before);
    expect(existsSync(`${path}-wal`)).toBe(false);
    // The lock is free again: once the file is moved aside, the store opens.
    renameSync(path, `${path}.old`);
    await open(dataDir);
  });

  test("in WAL mode is read without changing the file", async () => {
    const dataDir = tempDir();
    const path = join(dataDir, "quantext.db");
    const db = await openDriver(path); // WAL mode
    db.exec("CREATE TABLE ingest_files (path TEXT)");
    db.close();
    const sidecars = () => [existsSync(`${path}-wal`), existsSync(`${path}-shm`)];
    const before = { bytes: readFileSync(path), sidecars: sidecars() }; // Bun's SQLite on macOS keeps them after close
    await expect(openStore({ dataDir })).rejects.toThrow("move it aside");
    expect(readFileSync(path).equals(before.bytes)).toBe(true);
    // Node probes with immutable=1 and adds no side file; Bun opens the plain path (store/own.ts), and SQLite may.
    if (process.versions.bun === undefined) expect(sidecars()).toEqual(before.sidecars);
  });

  test("an empty file is a new store", async () => {
    const dataDir = tempDir();
    writeFileSync(join(dataDir, "quantext.db"), "");
    expect((await open(dataDir)).schemaVersion).toBe(SCHEMA_VERSION);
  });
});

test("migrates a database of schema version 1 to the current version and keeps its rows", async () => {
  const dataDir = tempDir();
  const store = await openStore({ dataDir });
  const db = store.db;
  // Back to version 1: drop what versions 2 to 5 added.
  db.exec(`ALTER TABLE log_blocks DROP COLUMN parts; ALTER TABLE calls DROP COLUMN response; DROP TABLE change_cursor; DROP INDEX sessions_changed; ALTER TABLE sessions DROP COLUMN changed_seq;
    DROP INDEX calls_lane; ALTER TABLE calls DROP COLUMN cache_boundary_offset;
    ALTER TABLE calls DROP COLUMN unit_read_usd; ALTER TABLE calls DROP COLUMN unit_rest_usd;
    DROP TABLE project_memory; UPDATE schema_version SET version = 1`);
  db.exec("INSERT INTO logs (path, harness, adapter_version) VALUES ('/l.jsonl', 'claude-code', 1)");
  store.close();
  const again = await openStore({ dataDir });
  onCleanup(() => again.close());
  expect(again.schemaVersion).toBe(SCHEMA_VERSION);
  expect(again.db.prepare("SELECT path FROM logs").all()).toEqual([{ path: "/l.jsonl" }]);
  expect(again.memory.marks()).toEqual([]);
});
