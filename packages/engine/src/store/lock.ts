/**
 * The writer lock, so that two engines never write one database. It is an OS file lock: a small SQLite database
 * held in an exclusive transaction for as long as the store is open. The OS releases it when the process ends,
 * also when it is killed, so there is no stale lock and no pid check. The pid file only tells who holds it.
 */
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import type { RawDatabase } from "./driver.ts";
import { openRaw } from "./driver.ts";

export class StoreLockedError extends Error {
  /** The holder's pid, as its pid file says; undefined when the file is missing or unreadable. */
  readonly pid: number | undefined;
  constructor(path: string, pid: number | undefined) {
    super(`another engine${pid === undefined ? "" : ` (pid ${pid})`} writes this store: ${path}`);
    this.name = "StoreLockedError";
    this.pid = pid;
  }
}

export interface Lock {
  release(): void;
}

/** Take the lock at `path` (the pid goes to `pidPath`), or throw StoreLockedError while another process holds it. */
export async function acquireLock(path: string, pidPath: string): Promise<Lock> {
  let db: RawDatabase;
  try {
    db = await hold(path, pidPath);
  } catch (error) {
    if (!/not a database/.test(String(error))) throw error;
    rmSync(path, { force: true }); // a lock file of an older engine (JSON): no SQLite lock can be held on it
    db = await hold(path, pidPath);
  }
  writeFileSync(pidPath, String(process.pid));
  return {
    release() {
      rmSync(pidPath, { force: true });
      db.exec("ROLLBACK");
      db.close();
    },
  };
}

async function hold(path: string, pidPath: string): Promise<RawDatabase> {
  const db = await openRaw(path);
  try {
    db.exec("PRAGMA busy_timeout = 0");
    db.exec("PRAGMA locking_mode = EXCLUSIVE");
    db.exec("BEGIN EXCLUSIVE");
    return db;
  } catch (error) {
    db.close();
    if (/database is locked|SQLITE_BUSY/.test(String(error))) throw new StoreLockedError(path, holderPid(pidPath));
    throw error;
  }
}

function holderPid(pidPath: string): number | undefined {
  try {
    const pid = Number(readFileSync(pidPath, "utf8"));
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
