/**
 * Demo mode: hide local paths in what the query layer gives out. A path in the project is shown relative to it,
 * a path in a home folder (of anyone, on macOS, Linux or Windows, also JSON-escaped or encoded as a folder name)
 * under `~`. The user name is hidden where it stands next to a path or an address (`name@host`).
 */
import type { JsonValue } from "@quantext/shared";

export interface Redactor {
  /** The text with local paths hidden; `root`: the project, whose paths are shown relative to it. */
  (text: string, root?: string): string;
  /** Every string in a JSON value redacted; keys stay as they are. */
  json<T extends JsonValue>(value: T, root?: string): T;
}

/** Not part of a path name: what may follow a folder's name when the path ends there. */
const END = "(?![\\w.-])";
const HOME_PATTERNS: readonly RegExp[] = [
  /\b[A-Za-z]:(?:\\{1,2}|\/)Users(?:\\{1,2}|\/)[\w.-]+/g,
  /\/Users\/(?!(?:Shared|Guest)\b)[\w.-]+/g,
  /\/home\/[\w.-]+/g,
  /\/root(?=\/|\\|$|[^\w.-])/g,
];
/** Claude Code names a project's folder after its path, with each `/` as `-`. */
const ENCODED_HOME = /(?<![\w-])-(?:Users|home)-[^-/\\\s"']+/g;

export function createRedactor(env: { home?: string; user?: string } = {}): Redactor {
  const home = env.home === undefined || env.home === "" ? undefined : env.home;
  const user = env.user !== undefined && env.user.length >= 2 ? env.user : undefined;
  const userPattern =
    user === undefined
      ? undefined
      : new RegExp(`(?<=[@/\\\\-])${escapeRegExp(user)}(?![\\w])|(?<![\\w.-])${escapeRegExp(user)}(?=@)`, "g");
  const redact = ((text: string, root?: string) => {
    let out = text;
    if (root !== undefined && root !== "") out = relative(out, root);
    if (home !== undefined) {
      for (const form of forms(home)) out = out.replace(new RegExp(`${escapeRegExp(form)}${END}`, "g"), "~");
    }
    for (const pattern of HOME_PATTERNS) out = out.replace(pattern, "~");
    out = out.replace(ENCODED_HOME, "-~");
    if (userPattern !== undefined) out = out.replace(userPattern, "user");
    return out;
  }) as Redactor;
  redact.json = <T extends JsonValue>(value: T, root?: string): T => deep(value, (s) => redact(s, root)) as T;
  return redact;
}

/** Whether a project is visible: no allowlist, or the list names its path or its last folder name. */
export function projectAllowed(project: string | undefined, allowed: readonly string[] | undefined): boolean {
  if (allowed === undefined) return true;
  if (project === undefined) return false;
  return allowed.some((name) => name === project || name === lastFolder(project));
}

/** The last folder name of a path, with `/` or `\` separators. */
export function lastFolder(path: string): string {
  const parts = path.split(/[\\/]/).filter((p) => p !== "");
  return parts.at(-1) ?? path;
}

/** Paths in the project relative to it (`src/a.ts`); the project itself as `.`. */
function relative(text: string, root: string): string {
  let out = text;
  for (const form of forms(root)) {
    const sep = form.includes("\\\\") ? "\\\\\\\\" : form.includes("\\") ? "\\\\" : "/";
    out = out.replace(new RegExp(`${escapeRegExp(form)}(?:${sep}|/)`, "g"), "");
    out = out.replace(new RegExp(`${escapeRegExp(form)}${END}`, "g"), ".");
  }
  return out;
}

/** A path as it may appear in text: as is, and JSON-escaped when it has backslashes. */
function forms(path: string): string[] {
  const trimmed = path.replace(/[\\/]+$/, "");
  return trimmed.includes("\\") ? [trimmed.replace(/\\/g, "\\\\"), trimmed] : [trimmed];
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function deep(value: JsonValue, map: (s: string) => string): JsonValue {
  if (typeof value === "string") return map(value);
  if (Array.isArray(value)) return value.map((v) => deep(v, map));
  if (value === null || typeof value !== "object") return value;
  const out: { [key: string]: JsonValue } = {};
  for (const [key, child] of Object.entries(value)) out[key] = deep(child, map);
  return out;
}
