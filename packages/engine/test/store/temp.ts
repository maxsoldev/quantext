/** Temporary folders for store and ingest tests, removed after each test. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";

const dirs: string[] = [];
const cleanups: (() => void | Promise<void>)[] = [];

/** A new empty folder, removed after the test. */
export function tempDir(prefix = "qx-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/** Run `fn` after the test, before the folders are removed (close stores, stop watchers). */
export function onCleanup(fn: () => void | Promise<void>): void {
  cleanups.push(fn);
}

afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
