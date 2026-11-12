/**
 * Read each project's memory folder (`<root>/projects/<project>/memory/*.md`) read-only into the store. A file whose
 * size and mtime are as stored is not read again; a file that is gone is deleted from the store.
 */
import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { MemoryDocument } from "@quantext/shared";
import type { Store } from "../store/index.ts";
import type { PathError } from "./discover.ts";
import { describe } from "./discover.ts";

/** Bring the store's memory documents up to date with the files; returns what could not be read. */
export async function ingestMemory(root: string, store: Store): Promise<PathError[]> {
  const errors: PathError[] = [];
  const projects = await entries(join(root, "projects"), errors);
  const stored = new Map(store.memory.marks().map((m) => [`${m.projectDir}\0${m.path}`, m]));
  const put: MemoryDocument[] = [];
  const seen = new Set<string>();
  for (const project of projects.filter((e) => e.isDirectory())) {
    const projectDir = join(root, "projects", project.name);
    const folder = join(projectDir, "memory");
    for (const file of await entries(folder, errors, true)) {
      if (!file.isFile() || !file.name.endsWith(".md")) continue;
      const key = `${projectDir}\0${file.name}`;
      const path = join(folder, file.name);
      seen.add(key);
      try {
        const s = await stat(path);
        const old = stored.get(key);
        if (old !== undefined && old.size === s.size && old.mtimeMs === s.mtimeMs) continue;
        const content = await readFile(path, "utf8");
        put.push({ projectDir, path: file.name, content, mtimeMs: s.mtimeMs, size: s.size });
      } catch (error) {
        errors.push({ path, error: describe(error) });
      }
    }
  }
  // Only documents of this root's project folders: another root's are not this scan's to remove.
  const mine = (m: { projectDir: string }) => dirname(m.projectDir) === join(root, "projects");
  const remove = [...stored.entries()].filter(([key, m]) => mine(m) && !seen.has(key)).map(([, m]) => m);
  if (put.length > 0 || remove.length > 0) store.memory.write({ put, remove });
  return errors;
}

/** The entries of a folder; a missing one is empty (no projects yet, no memory folder). */
async function entries(dir: string, errors: PathError[], optional = false): Promise<Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || (optional && code === "ENOTDIR")) return [];
    errors.push({ path: dir, error: describe(error) });
    return [];
  }
}
