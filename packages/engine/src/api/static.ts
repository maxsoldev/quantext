/**
 * The viewer's files from one folder: only regular files inside it (after symbolic links are resolved), no folder
 * listing, no dot files, a fixed type per extension. A path with no extension that is not a file is a page of the
 * single-page viewer: it gets `index.html`.
 */
import { realpathSync } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { extname, join, sep } from "node:path";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
};

/** Larger files are not the viewer's; refuse rather than read them into memory. */
const MAX_FILE_BYTES = 32 * 1024 * 1024;

export interface StaticFile {
  bytes: Uint8Array;
  type: string;
  html: boolean;
  /** Under `assets/`, where the viewer's build puts files named by their hash: cached for good. */
  immutable: boolean;
}

export interface StaticFiles {
  /** The file for these decoded path segments, `index.html` for a page, or undefined (404). */
  get(segments: readonly string[]): Promise<StaticFile | undefined>;
}

export function staticFiles(dir: string): StaticFiles {
  const root = realpathSync(dir);
  const inside = (path: string) => path === root || path.startsWith(root + sep);
  const load = async (relative: readonly string[]): Promise<StaticFile | undefined> => {
    let path: string;
    try {
      path = await realpath(join(root, ...relative));
    } catch (error) {
      if (missing(error)) return undefined;
      throw error;
    }
    if (!inside(path)) return undefined; // a symbolic link out of the folder
    const info = await stat(path);
    if (!info.isFile() || info.size > MAX_FILE_BYTES) return undefined;
    const ext = extname(path).toLowerCase();
    return {
      bytes: await readFile(path),
      type: TYPES[ext] ?? "application/octet-stream",
      html: ext === ".html",
      immutable: relative[0] === "assets",
    };
  };
  return {
    async get(segments) {
      const parts = segments.filter((s) => s !== "");
      if (!parts.every(safeSegment)) return undefined;
      const found = parts.length === 0 ? undefined : await load(parts);
      if (found !== undefined) return found;
      const last = parts.at(-1);
      if (last !== undefined && extname(last) !== "") return undefined; // a missing file, not a page
      return load(["index.html"]);
    },
  };
}

/** A decoded path segment that names a file in the folder: no `..`, no separators, no dot file, no NUL. */
function safeSegment(segment: string): boolean {
  return !segment.startsWith(".") && !/[/\\\0:]/.test(segment);
}

function missing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}
