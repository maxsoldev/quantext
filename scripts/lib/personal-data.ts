export interface Finding {
  line: number;
  kind: string;
  match: string;
}

export interface ScanOptions {
  /** Exact addresses that may appear, e.g. a project's public contact address. */
  allowEmails?: readonly string[];
}

interface Pattern {
  kind: string;
  regex: RegExp;
  /** Return true when this match is not personal data. */
  allow?: (match: string, options: ScanOptions) => boolean;
}

/** Home folders that belong to no person. */
const SHARED_HOMES = "Shared|Guest";

/** Domains reserved for documentation and tests (RFC 2606, RFC 6761). */
const RESERVED_DOMAIN = /(?:^|\.)(?:example\.(?:com|net|org)|example|test|invalid|localhost)$/i;

const PATTERNS: readonly Pattern[] = [
  { kind: "home path", regex: new RegExp(`/(?:Users|home)/(?!(?:${SHARED_HOMES})\\b)[\\w.-]+`, "g") },
  { kind: "home path", regex: /\b[A-Za-z]:\\Users\\[\w.-]+/g },
  {
    kind: "email",
    regex: /[\w.%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g,
    allow: (match, options) =>
      RESERVED_DOMAIN.test(match.slice(match.indexOf("@") + 1)) || (options.allowEmails ?? []).includes(match),
  },
  { kind: "AWS access key", regex: /\b(?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}\b/g },
  { kind: "API key (sk-)", regex: /\bsk-[A-Za-z0-9_-]{20,}/g },
];

/** Find personal data (home paths, emails, keys) in `text`, one finding per match. */
export function scanText(text: string, options: ScanOptions = {}): Finding[] {
  const findings: Finding[] = [];
  for (const [index, line] of text.split("\n").entries()) {
    for (const { kind, regex, allow } of PATTERNS) {
      for (const [match] of line.matchAll(regex)) {
        if (!allow?.(match, options)) findings.push({ line: index + 1, kind, match });
      }
    }
  }
  return findings;
}
