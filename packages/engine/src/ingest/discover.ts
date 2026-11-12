/**
 * Find Claude Code transcripts under a config folder: `<session>.jsonl` at any depth under `<root>/projects`, with the subagent
 * transcripts of a session in `<session>/subagents/agent-<id>.jsonl` and their `agent-<id>.meta.json`.
 */

import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/** The files of one log: a main transcript and its subagents. The main transcript may not exist (yet). */
export interface LogFiles {
  main: string;
  subagents: SubagentFile[];
}

export interface SubagentFile {
  path: string;
  /** The transcript name given to the parser: the file name without `.jsonl`. */
  name: string;
  meta?: string;
}

export interface PathError {
  path: string;
  error: string;
}

/** Every log under `<root>/projects`, sorted by path. A missing projects folder is no error: there is nothing yet. */
export async function discoverLogs(root: string): Promise<{ logs: LogFiles[]; errors: PathError[] }> {
  const mains = new Set<string>();
  const errors: PathError[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" && dir === join(root, "projects")) return;
      errors.push({ path: dir, error: describe(error) });
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) mains.add(logOf(path));
    }
  };
  await walk(join(root, "projects"));
  const logs: LogFiles[] = [];
  for (const main of [...mains].sort()) {
    const found = await logFiles(main);
    logs.push(found.files);
    errors.push(...found.errors);
  }
  return { logs, errors };
}

/** The main transcript of the log a file belongs to: a subagent file belongs to `<session>.jsonl`. */
export function logOf(path: string): string {
  if (basename(dirname(path)) === "subagents") return `${dirname(dirname(path))}.jsonl`;
  return path;
}

/** The files of the log of a main transcript, with the subagents that exist now. */
export async function logFiles(main: string): Promise<{ files: LogFiles; errors: PathError[] }> {
  const dir = join(main.replace(/\.jsonl$/, ""), "subagents");
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR") {
      return { files: { main, subagents: [] }, errors: [] };
    }
    return { files: { main, subagents: [] }, errors: [{ path: dir, error: describe(error) }] };
  }
  const present = new Set(names);
  const subagents = names
    .filter((n) => n.endsWith(".jsonl"))
    .sort()
    .map((n): SubagentFile => {
      const name = n.replace(/\.jsonl$/, "");
      const meta = `${name}.meta.json`;
      const file: SubagentFile = { path: join(dir, n), name };
      if (present.has(meta)) file.meta = join(dir, meta);
      return file;
    });
  return { files: { main, subagents }, errors: [] };
}

/** An error as one line: its code and message. */
export function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
