/** A project's memory: the index (MEMORY.md) first, then the files by their last change; the index's links. */
import type { MemoryDocumentView } from "@quantext/shared";

export const INDEX = "MEMORY.md";

export function memoryFiles(docs: readonly MemoryDocumentView[]): MemoryDocumentView[] {
  return [...docs].sort((a, b) => Number(b.path === INDEX) - Number(a.path === INDEX) || b.mtimeMs - a.mtimeMs);
}

export interface IndexEntry {
  title: string;
  file: string;
  hook: string;
}

/** The `- [Title](file.md) — hook` lines of the index. */
export function indexEntries(index: string): IndexEntry[] {
  const out: IndexEntry[] = [];
  for (const line of index.split("\n")) {
    const m = /^\s*[-*]\s*\[([^\]]+)\]\(([^)]+)\)\s*(?:[—–-]+\s*(.*))?$/.exec(line);
    if (m?.[1] && m[2]) out.push({ title: m[1], file: m[2], hook: (m[3] ?? "").trim() });
  }
  return out;
}
