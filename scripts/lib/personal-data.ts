import { posix } from "node:path";

export interface Finding {
  line: number;
  kind: string;
  match: string;
}

export interface ScanOptions {
  /** Local identity terms (git email, host name) built at run time; never stored in the repo. */
  deny?: readonly string[];
}

interface Pattern {
  kind: string;
  regex: RegExp;
  /** Return true when this match is not personal data. */
  allow?: (match: string) => boolean;
  /** Ignore matches inside http(s) and ws(s) URLs, where `/home/` and `/Users/` name web pages. */
  skipInWebUrls?: boolean;
}

/** Home folders that belong to no person. */
const SHARED_HOMES = "(?:Shared|Guest)\\b";

/** Domains reserved for documentation and tests (RFC 2606, RFC 6761). */
const RESERVED_DOMAIN = /(?:^|\.)(?:example\.(?:com|net|org)|example|test|invalid|localhost)$/i;

const WEB_URL = /\b(?:https?|wss?):\/\/[^\s"'<>)\]]+/g;

/** Local terms shorter than this match too much ordinary text (`pc`). */
const MIN_LOCAL_TERM = 4;

const PATTERNS: readonly Pattern[] = [
  { kind: "home path", regex: new RegExp(`/(?:Users|home)/(?!${SHARED_HOMES})[\\w.-]+`, "g"), skipInWebUrls: true },
  { kind: "home path", regex: /\/root\//g, skipInWebUrls: true },
  // Windows, also JSON-escaped (`C:\\Users\\<name>`).
  { kind: "home path", regex: /\b[A-Za-z]:\\{1,2}Users\\{1,2}[\w.-]+/g },
  // Claude Code project folders encode `/Users/<name>/x` as `-Users-<name>-x`.
  { kind: "home path", regex: new RegExp(`(?<![\\w-])-(?:Users|home)-(?!${SHARED_HOMES})[\\w.]+`, "g") },
  { kind: "home path", regex: new RegExp(`%2F(?:Users|home)%2F(?!${SHARED_HOMES})[\\w.-]+`, "gi") },
  {
    kind: "email",
    regex: /[\w.%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g,
    allow: (match) => {
      const [local = "", domain = ""] = match.split("@");
      return RESERVED_DOMAIN.test(domain) || local === "git"; // `git@host:org/repo` is an SSH remote
    },
  },
  { kind: "AWS access key", regex: /\b(?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}\b/g },
  { kind: "API key (sk-)", regex: /\bsk-[A-Za-z0-9_-]{20,}/g },
];

/** Find personal data (home paths, emails, keys, local identity) in `text`; at most one finding per line and kind. */
export function scanText(text: string, options: ScanOptions = {}): Finding[] {
  const patterns = [...PATTERNS, ...identityPatterns(options.deny ?? [])];
  const findings: Finding[] = [];
  for (const [index, line] of text.split("\n").entries()) {
    const urls = [...line.matchAll(WEB_URL)].map((m) => [m.index, m.index + m[0].length] as const);
    const inUrl = (at: number) => urls.some(([start, end]) => at >= start && at < end);
    const seen = new Set<string>();
    for (const { kind, regex, allow, skipInWebUrls } of patterns) {
      for (const m of line.matchAll(regex)) {
        if (allow?.(m[0]) || (skipInWebUrls && inUrl(m.index)) || seen.has(kind)) continue;
        seen.add(kind);
        findings.push({ line: index + 1, kind, match: m[0] });
      }
    }
  }
  return findings;
}

/** Host names that name no person: loopback, CI runner hosts (GitHub, Azure, AWS) and common OS defaults. */
const GENERIC_HOST = new RegExp(
  `^(?:${[
    "localhost",
    "runner",
    "runnervm\\w*",
    "fv-az[\\w-]*",
    "ip-[\\d-]+",
    "ec2[\\w-]*",
    "buildkitsandbox",
    "codespaces-[\\w-]*",
    "ubuntu",
    "debian",
    "fedora",
    "raspberrypi",
    "macbook(?:-pro|-air)?",
    "imac",
    "mac-mini",
    "desktop",
    "laptop",
    "devbox",
  ].join("|")})(?:\\.|$)`,
  "i",
);

/**
 * Terms that identify this machine's user: the git email and the host name, as literals.
 * Not the login name: user names show up in home paths, which the path rules catch, and CI names (`runner`)
 * are ordinary words. Empty, short and generic host names are skipped.
 */
export function localDenylist(local: { email: string; hostname: string }): string[] {
  const host = local.hostname.trim().toLowerCase();
  const hosts = GENERIC_HOST.test(host) ? [] : [host, host.split(".")[0] ?? ""];
  const terms = [local.email.trim().toLowerCase(), ...hosts];
  return [...new Set(terms.filter((t) => t.length >= MIN_LOCAL_TERM))];
}

function identityPatterns(deny: readonly string[]): Pattern[] {
  return deny.map((term) => ({
    kind: "local identity",
    regex: new RegExp(`(?<![A-Za-z0-9])${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9])`, "gi"),
  }));
}

export interface PatchFinding {
  commit: string;
  path: string;
  kind: string;
}

/**
 * Find personal data in the lines (and paths) that commits added, in `git log -p` output.
 * Catches data that a later commit removed. At most one finding per commit, file and kind.
 */
export function scanPatch(log: string, options: ScanOptions = {}): PatchFinding[] {
  const findings: PatchFinding[] = [];
  const seen = new Set<string>();
  let commit = "";
  let path = "";
  let inHeader = false;
  const add = (text: string) => {
    for (const { kind } of scanText(text, options)) {
      const key = `${commit} ${path} ${kind}`;
      if (seen.has(key)) continue;
      seen.add(key);
      findings.push({ commit: commit.slice(0, 7), path, kind });
    }
  };
  for (const line of log.split("\n")) {
    if (line.startsWith("commit ")) {
      commit = line.slice("commit ".length).trim();
      inHeader = false;
    } else if (line.startsWith("diff --git ")) {
      inHeader = true;
      path = "";
    } else if (inHeader && line.startsWith("+++ ")) {
      path = line === "+++ /dev/null" ? "" : line.slice("+++ b/".length);
      if (path !== "") add(path);
    } else if (line.startsWith("@@")) {
      inHeader = false;
    } else if (!inHeader && path !== "" && line.startsWith("+")) {
      add(line.slice(1));
    }
  }
  return findings;
}

/**
 * A function that makes a path safe to print: each segment with personal data becomes `<redacted>` (the file keeps
 * its extension). When the match spans segments (`x/Users/<name>`), the whole path becomes `<redacted path #N>`,
 * numbered per run (the same path gets the same number), so nothing in the output can be guessed back.
 */
export function createPathRedactor(options: ScanOptions = {}): (path: string) => string {
  const numbers = new Map<string, number>();
  return (path) => {
    if (scanText(path, options).length === 0) return path;
    const segments = path.split("/");
    const redacted = segments.map((segment, index) => {
      if (scanText(segment, options).length === 0) return segment;
      return `<redacted>${index === segments.length - 1 ? posix.extname(segment) : ""}`;
    });
    const result = redacted.join("/");
    if (scanText(result, options).length === 0) return result;
    if (!numbers.has(path)) numbers.set(path, numbers.size + 1);
    return `<redacted path #${numbers.get(path)}>`;
  };
}
