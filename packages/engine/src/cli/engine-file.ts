/**
 * `engine.json` in the data folder: where the running engine listens (ADR 25). It is a hint for a second start
 * and for the mod; the writer lock is what keeps one engine per store. Written whole (a temporary file renamed),
 * so a reader never sees half of it.
 */
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EngineFile } from "@quantext/shared";

export const ENGINE_FILE = "engine.json";

/** The engine file, or undefined when there is none or it is not one (a stale or broken file is not an engine). */
export function readEngineFile(dataDir: string): EngineFile | undefined {
  let text: string;
  try {
    text = readFileSync(join(dataDir, ENGINE_FILE), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined; // not JSON: no engine wrote it whole; the next engine replaces it
  }
  const f = value as Partial<EngineFile> | null;
  const port = f?.port;
  const pid = f?.pid;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65_535) return undefined;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid < 1) return undefined;
  return f as EngineFile;
}

export function writeEngineFile(dataDir: string, file: EngineFile): void {
  const path = join(dataDir, ENGINE_FILE);
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

/** Remove the engine file if it still names this process (a later engine may have replaced it). */
export function removeEngineFile(dataDir: string, pid: number): void {
  if (readEngineFile(dataDir)?.pid === pid) rmSync(join(dataDir, ENGINE_FILE), { force: true });
}

/** The engine's address: built from the port alone, so nothing else can reach a browser command line. */
export function engineUrl(port: number): string {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`not a port: ${port}`);
  return `http://127.0.0.1:${port}/`;
}
