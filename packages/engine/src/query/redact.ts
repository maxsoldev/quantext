/**
 * Demo mode: hide local paths in what the query layer gives out. Percent-encoded text is decoded first. A path in
 * the project is shown relative to it; every hidden project (by path, JSON-escaped, as the harness's encoded folder
 * name, or by its folder name) becomes a placeholder; a home folder (of anyone, on macOS, Linux or Windows, also
 * encoded) becomes `~`; the user name, in any case, is hidden next to a path, `:`, `~` or an address (`name@host`).
 */
import type { JsonValue } from "@quantext/shared";

export interface Redactor {
  /** The text with local paths hidden; `root`: the project, whose paths are shown relative to it. */
  (text: string, root?: string): string;
  /** Every string in a JSON value redacted; keys stay as they are. */
  json<T extends JsonValue>(value: T, root?: string): T;
}

export interface RedactorOptions {
  home?: string;
  user?: string;
  /** Projects that must not be seen: each path, wherever it shows, becomes HIDDEN_PROJECT. */
  hidden?: readonly string[];
  /** Hide paths (relative to the project, home folders as `~`); false: only the hidden projects. Default true. */
  paths?: boolean;
  /** The machine's name, shown as `<host>`. */
  host?: string;
}

export const HIDDEN_PROJECT = "<hidden project>";

/** An e-mail address; `git@` is an SSH remote, not a person. */
const EMAIL =
  /(?<![\p{L}\p{N}_.%+-])(?!git@)[\p{L}\p{N}_.%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.\p{L}{2,}(?![\p{L}\p{N}])/gu;

/** A character of a folder name: anything but a separator, a quote, a line end or what no file name holds. */
const NAME = "[^\\\\/\"'`\\n\\r\\t<>|*?:]+";
/** Not part of a path name: what may follow a folder's name when the path ends there. */
const END = "(?![\\p{L}\\p{N}_.-])";
const HOME_PATTERNS: readonly RegExp[] = [
  new RegExp(`\\b[A-Za-z]:(?:\\\\{1,2}|/)Users(?:\\\\{1,2}|/)${NAME}`, "gu"),
  new RegExp(`/Users/(?!(?:Shared|Guest)(?:[\\\\/"']|$))${NAME}`, "gu"),
  new RegExp(`/home/${NAME}`, "gu"),
  /\/root(?=[\\/]|$|[^\w.-])/gu,
];
/** The harness names a project's folder after its path, each character that is not a letter or digit as `-`. */
const ENCODED_HOME = /(?:\b[A-Za-z]--|(?<![\w-])-)(?:Users|home)-[^-/\\\s"']+/gu;

export function createRedactor(options: RedactorOptions = {}): Redactor {
  const home = options.home === undefined || options.home === "" ? undefined : trimSeparators(options.home);
  const user = options.user !== undefined && options.user.length >= 2 ? options.user : undefined;
  const userPattern =
    user === undefined
      ? undefined
      : new RegExp(
          `(?<=[@/\\\\:~-])${escapeRegExp(user)}(?![\\p{L}\\p{N}_])|(?<![\\p{L}\\p{N}_.-])${escapeRegExp(user)}(?=@)`,
          "giu",
        );
  const encodedUser =
    user === undefined
      ? undefined
      : new RegExp(`(?:\\b[A-Za-z]--|(?<![\\w-])-)(?:Users|home)-${escapeRegExp(encode(user))}(?![A-Za-z0-9])`, "gu");
  const hidden = [...(options.hidden ?? [])].map(trimSeparators).sort((a, b) => b.length - a.length);
  const paths = options.paths ?? true;
  const host =
    options.host !== undefined && options.host.length >= 3 ? options.host.replace(/\.local$/i, "") : undefined;
  const hostPattern =
    host === undefined ? undefined : new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(host)}(?![\\p{L}\\p{N}])`, "giu");
  const redact = ((text: string, root?: string) => {
    let out = decodePercent(text);
    if (paths && root !== undefined && root !== "") out = relative(out, trimSeparators(root));
    for (const project of hidden) out = hide(out, project);
    if (!paths) return out;
    out = out.replace(EMAIL, "<email>");
    if (hostPattern !== undefined) out = out.replace(hostPattern, "<host>");
    if (home !== undefined) {
      for (const form of forms(home)) out = out.replace(new RegExp(`${escapeRegExp(form)}${END}`, "gu"), "~");
      out = out.replace(new RegExp(`${escapeRegExp(encode(home))}(?![A-Za-z0-9])`, "g"), "-~");
    }
    for (const pattern of HOME_PATTERNS) out = out.replace(pattern, "~");
    if (encodedUser !== undefined) out = out.replace(encodedUser, "-~");
    out = out.replace(ENCODED_HOME, "-~");
    if (userPattern !== undefined) out = out.replace(userPattern, "user");
    return out;
  }) as Redactor;
  redact.json = <T extends JsonValue>(value: T, root?: string): T => deep(value, (s) => redact(s, root)) as T;
  return redact;
}

/** A path without the separators at its end, as the allowlist compares it. */
export function trimSeparators(path: string): string {
  return path.length > 1 ? path.replace(/[\\/]+$/, "") : path;
}

/** Whether a project is visible: no allowlist, or the list names its exact path. */
export function projectAllowed(project: string | undefined, allowed: readonly string[] | undefined): boolean {
  if (allowed === undefined) return true;
  if (project === undefined) return false;
  const path = trimSeparators(project);
  return allowed.some((name) => trimSeparators(name) === path);
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
    out = out.replace(new RegExp(`${escapeRegExp(form)}(?:${sep}|/)`, "gu"), "");
    out = out.replace(new RegExp(`${escapeRegExp(form)}${END}`, "gu"), ".");
  }
  return out;
}

/** A hidden project's path in every form, its encoded folder name, and its folder name as a word, as a placeholder. */
function hide(text: string, project: string): string {
  let out = text;
  const any = (form: string) => new RegExp(escapeRegExp(form), "giu");
  for (const form of forms(project)) out = out.replace(any(form), HIDDEN_PROJECT);
  out = out.replace(any(encode(project)), HIDDEN_PROJECT);
  const name = lastFolder(project);
  if (name.length >= 4) {
    // As a word: next to `.`, `_` or `-` too (`name.git`, `mcp__name__tool`), in any case.
    out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(name)}(?![\\p{L}\\p{N}])`, "giu"), HIDDEN_PROJECT);
  }
  return out;
}

/** A path as it may appear in text: as is, JSON-escaped and with `/` when it has backslashes. */
function forms(path: string): string[] {
  return path.includes("\\") ? [path.replace(/\\/g, "\\\\"), path, path.replace(/\\/g, "/")] : [path];
}

/** How the harness names a folder after a path. */
function encode(path: string): string {
  return path.replace(/[^A-Za-z0-9]/g, "-");
}

/**
 * Encoded separators and text decoded, so that the patterns see plain paths: percent-encoded runs (also encoded
 * twice, `%252F`), JSON-escaped slashes (`\/`) and HTML character references (`&#x2F;`, `&#47;`).
 */
function decodePercent(text: string): string {
  let out = text
    .replace(/\\\//g, "/")
    .replace(/&#x([0-9a-f]{1,6});/gi, (ref, hex: string) => character(Number.parseInt(hex, 16), ref))
    .replace(/&#(\d{1,7});/g, (ref, dec: string) => character(Number(dec), ref));
  for (let i = 0; i < 3 && out.includes("%"); i++) {
    const next = decodeRuns(out);
    if (next === out) break;
    out = next;
  }
  return out;
}

/** The character of a code point, or the reference as it was when it names none. */
function character(code: number, ref: string): string {
  return code <= 0x10ffff ? String.fromCodePoint(code) : ref;
}

/** Percent-encoded runs decoded (`%2F` is `/`); a run that is not valid UTF-8 keeps all but its separators. */
function decodeRuns(text: string): string {
  return text.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      return run.replace(/%2f/gi, "/").replace(/%5c/gi, "\\"); // not UTF-8: keep it, but decode the separators
    }
  });
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
