/**
 * Find Claude Code transcripts under a config folder: `<session>.jsonl` at any depth under `<root>/projects`, with the subagent
 * transcripts of a session in `<session>/subagents/agent-<id>.jsonl` and their `agent-<id>.meta.json`.
 */

import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";

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

/**
 * Every log under `<root>/projects`, sorted by path, the folders that could not be read, and the symbolic links
 * that were not followed. A missing projects folder is no error: there is nothing yet.
 */
export async function discoverLogs(root: string): Promise<{ logs: LogFiles[]; errors: PathError[]; links: string[] }> {
  const mains = new Set<string>();
  const errors: PathError[] = [];
  const links: string[] = [];
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
      else if (entry.isSymbolicLink()) links.push(path); // not followed: it may lead out of the folder, or loop
    }
  };
  await walk(join(root, "projects"));
  const logs: LogFiles[] = [];
  for (const main of [...mains].sort()) {
    const found = await logFiles(main);
    logs.push(found.files);
    errors.push(...found.errors);
  }
  return { logs, errors, links };
}

/**
 * The main transcript of the log a file belongs to: a file anywhere under `<session>/subagents/` (also a workflow's
 * `subagents/workflows/<id>/`) belongs to `<session>.jsonl`.
 */
export function logOf(path: string): string {
  const parts = path.split(sep);
  const at = parts.lastIndexOf("subagents", parts.length - 2);
  return at > 0 ? `${parts.slice(0, at - 1).join(sep)}${sep}${parts[at - 1]}.jsonl` : path;
}

/**
 * The files of the log of a main transcript, with the subagents that exist now, at any depth under its
 * `subagents/` folder. A subagent's transcript name is its path below that folder, without `.jsonl`.
 */
export async function logFiles(main: string): Promise<{ files: LogFiles; errors: PathError[] }> {
  const root = join(main.replace(/\.jsonl$/, ""), "subagents");
  const subagents: SubagentFile[] = [];
  const errors: PathError[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (dir === root && (code === "ENOENT" || code === "ENOTDIR")) return;
      errors.push({ path: dir, error: describe(error) });
      return;
    }
    const names = new Set(entries.map((e) => e.name));
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        const name = relative(root, path)
          .split(sep)
          .join("/")
          .replace(/\.jsonl$/, "");
        const meta = entry.name.replace(/\.jsonl$/, ".meta.json");
        const file: SubagentFile = { path, name };
        if (names.has(meta)) file.meta = join(dir, meta);
        subagents.push(file);
      }
    }
  };
  await walk(root);
  subagents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { files: { main, subagents }, errors };
}

/** An error as one line: its code and message. */
export function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
