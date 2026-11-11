export interface Finding {
  line: number;
  kind: string;
  match: string;
}

export interface ScanOptions {
  /** Local identity terms (user name, email, host name) built at run time; never stored in the repo. */
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

/** Local names shorter than this match too much ordinary text (`max`, `pc`). */
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

/** Terms that identify this machine's user: the user name, git email and host name, if long enough to scan for. */
export function localDenylist(local: { user: string; email: string; hostname: string }): string[] {
  const host = local.hostname.toLowerCase();
  const terms = [local.user, local.email, host, host.split(".")[0] ?? ""].map((t) => t.trim().toLowerCase());
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
