/**
 * The writer lock: a file in the data folder that names the process that writes the store, so two engines never
 * write one database. A lock whose process is gone (or that is not a lock) is stale and taken over.
 */
import { randomUUID } from "node:crypto";
import { linkSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";

export class StoreLockedError extends Error {
  readonly pid: number;
  constructor(path: string, pid: number) {
    super(`another engine (pid ${pid}) writes this store: ${path}`);
    this.name = "StoreLockedError";
    this.pid = pid;
  }
}

export interface Lock {
  release(): void;
}

interface LockFile {
  pid: number;
  token: string;
}

/** Take the lock at `path`, or throw StoreLockedError when a running process holds it. */
export function acquireLock(path: string): Lock {
  const mine: LockFile = { pid: process.pid, token: randomUUID() };
  const text = JSON.stringify(mine);
  // Write the whole file first, then link it into place: the lock file is never seen half written.
  const temp = `${path}.${mine.token}`;
  writeFileSync(temp, text, { flag: "wx" });
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (tryLink(temp, path)) return { release: () => releaseIfMine(path, text) };
      const held = readLock(path);
      if (held === "gone") continue;
      if (held !== undefined && isAlive(held.pid)) throw new StoreLockedError(path, held.pid);
      removeStale(path, held);
    }
    throw new Error(`cannot take the writer lock ${path}: it keeps changing`);
  } finally {
    unlinkSync(temp);
  }
}

function tryLink(from: string, to: string): boolean {
  try {
    linkSync(from, to);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

/** The lock's content; undefined when it is not a lock, "gone" when the file went away meanwhile. */
function readLock(path: string): LockFile | undefined | "gone" {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "gone";
    throw error;
  }
  try {
    const value = JSON.parse(text) as Partial<LockFile>;
    return typeof value.pid === "number" && typeof value.token === "string" ? (value as LockFile) : undefined;
  } catch {
    return undefined; // not JSON: not a lock this engine wrote, so stale
  }
}

/** Move the stale lock aside, then check it is the one we judged: another engine may have just taken over. */
function removeStale(path: string, stale: LockFile | undefined): void {
  const aside = `${path}.stale-${randomUUID()}`;
  try {
    renameSync(path, aside);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const moved = readLock(aside);
  if (JSON.stringify(moved) !== JSON.stringify(stale)) tryLink(aside, path); // a fresh lock: put it back (unless yet another one took its place)
  unlinkSync(aside);
}

function releaseIfMine(path: string, text: string): void {
  try {
    if (readFileSync(path, "utf8") === text) unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/** Whether a process with this pid runs. EPERM: it runs, as another user. */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
