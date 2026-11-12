/**
 * `engine.json` in the data folder: where the running engine listens (ADR 25). It is a hint for a second start
 * and for the mod; the writer lock is what keeps one engine per store. Written whole (a temporary file renamed),
 * so a reader never sees half of it.
 */
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EngineFile } from "@quantext/shared";

export const ENGINE_FILE = "engine.json";

/**
 * The engine file, or undefined when there is none or it is not one: another process wrote it, so every field is
 * checked, and `url` is never read but built again from the port. A file that cannot be read is no engine
 * either; `warn` gets why.
 */
export function readEngineFile(dataDir: string, warn: (message: string) => void): EngineFile | undefined {
  const path = join(dataDir, ENGINE_FILE);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return undefined;
    if (code === "EACCES" || code === "EISDIR" || code === "EPERM") {
      warn(`cannot read ${path} (${code}); starting as if no engine ran`);
      return undefined;
    }
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined; // not JSON: no engine wrote it whole; the next engine replaces it
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const f = value as Record<string, unknown>;
  const { port, pid, version, apiVersion, startedAt } = f;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65_535) return undefined;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid < 1) return undefined;
  if (typeof version !== "string" || !/^[0-9A-Za-z.+-]{1,64}$/.test(version)) return undefined;
  if (apiVersion !== 1) return undefined;
  return {
    apiVersion,
    version,
    pid,
    port,
    url: engineUrl(port),
    startedAt: typeof startedAt === "string" ? printable(startedAt).slice(0, 64) : "",
  };
}

/** Text from another process, fit for a terminal: each control character (escape codes) becomes `?`. */
export function printable(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this replaces
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, "?");
}

export function writeEngineFile(dataDir: string, file: EngineFile): void {
  const path = join(dataDir, ENGINE_FILE);
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

/** Remove the engine file if it still names this process (a later engine may have replaced it). */
export function removeEngineFile(dataDir: string, pid: number): void {
  if (readEngineFile(dataDir, () => undefined)?.pid === pid) rmSync(join(dataDir, ENGINE_FILE), { force: true });
}

/** The engine's address: built from the port alone, so nothing else can reach a browser command line. */
export function engineUrl(port: number): string {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`not a port: ${port}`);
  return `http://127.0.0.1:${port}/`;
}
