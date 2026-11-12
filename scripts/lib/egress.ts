/**
 * The no-egress guard (SECURITY.md): find each way a shipped file could reach the network, other than the
 * engine's own server on 127.0.0.1 and requests to it. Code is checked on its AST (rolldown/parseAst); HTML,
 * CSS and JSON as text. URLs and argv are followed through constants, conditionals, concatenation, function
 * returns and the call sites of a parameter (resolve.ts). A value that cannot be followed is a finding.
 */
import { posix } from "node:path";
import { parseAst } from "rolldown/parseAst";
import type { Node, Parsed, Val, Vals } from "./resolve.ts";
import { calleeName, children, index, lineOf, resolve } from "./resolve.ts";

export interface ShippedFile {
  path: string;
  text: string;
}

export interface Finding {
  file: string;
  line: number;
  rule: string;
  detail: string;
}

/** A command a shipped file may run: argv by position, each an exact string, a set of strings, or null (any). */
export interface CommandRule {
  argv: (string | readonly string[] | null)[];
  reason: string;
}

export interface EgressPolicy {
  /** URLs that appear in shipped files only as text for people (never fetched), each with the reason. */
  documentationUrls: { prefix: string; reason: string }[];
  commands: CommandRule[];
}

const CODE = /\.[mc]?[jt]sx?$/;
const MARKUP = /\.(html?|css|svg|json|webmanifest|xml)$/;
/** XML namespace names: identifiers that look like URLs, never fetched. */
const XML_NAMESPACES = [
  "http://www.w3.org/1998/Math/MathML",
  "http://www.w3.org/1999/xhtml",
  "http://www.w3.org/1999/xlink",
  "http://www.w3.org/2000/svg",
  "http://www.w3.org/2000/xmlns/",
  "http://www.w3.org/XML/1998/namespace",
];
const URL_IN_TEXT = /\b(?:https?|wss?|ftp):\/\/[^\s"'`<>()\\]*/gi;
const PROTOCOL_RELATIVE_IN_MARKUP =
  /(?:\b(?:src|href|action|poster)\s*=\s*["']?|url\(\s*["']?|@import\s+["'])\/\/[^/\s"')]/gi;
const PROTOCOL_RELATIVE = /^\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:[/:?#]|$)/i;
const LOOPBACK = /^(?:https?|wss?):\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?:[:/?#]|$)/i;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
/** Calls and constructors that send a request to their first argument, and those that are never allowed. */
const URL_CALLS = new Set(["fetch", "importScripts"]);
const URL_CONSTRUCTORS = new Set(["EventSource", "WebSocket", "WebSocketStream"]);

/** Every finding in `files` (paths relative to the plugin root), by file, then line. */
export function findEgress(files: ShippedFile[], policy: EgressPolicy): Finding[] {
  const findings: Finding[] = [];
  const parsed: Parsed[] = [];
  for (const file of files) {
    const add = (offset: number, rule: string, detail: string) =>
      findings.push({ file: file.path, line: lineOf(file.text, offset), rule, detail });
    if (MARKUP.test(file.path)) scanMarkup(file.text, policy, add);
    if (!CODE.test(file.path)) continue;
    const program = parse(file.path, file.text);
    if (typeof program === "string") add(0, "parse", program);
    else parsed.push({ path: file.path, text: file.text, program, add });
  }
  const ctx = index(parsed);
  for (const p of parsed) checkCode(p, ctx, policy);
  return findings
    .map((f, order) => ({ f, order }))
    .sort((a, b) => (a.f.file < b.f.file ? -1 : a.f.file > b.f.file ? 1 : a.f.line - b.f.line || a.order - b.order))
    .map(({ f }) => f);
}

function scanMarkup(text: string, policy: EgressPolicy, add: Parsed["add"]): void {
  for (const m of text.matchAll(URL_IN_TEXT)) {
    if (isExternal(m[0], policy)) add(m.index, "url", `hard-coded external URL ${m[0]}`);
  }
  for (const m of text.matchAll(PROTOCOL_RELATIVE_IN_MARKUP)) add(m.index, "url", `protocol-relative URL ${m[0]}`);
}

/** True when `url` names a host other than loopback and is not on an allowlist. A URL with no host is not one. */
function isExternal(url: string, policy: EgressPolicy): boolean {
  const host = url.replace(/^[a-z]+:\/\//i, "").split(/[/?#]/)[0] ?? "";
  if (host === "" || LOOPBACK.test(url)) return false;
  if (XML_NAMESPACES.some((ns) => url === ns || url.startsWith(`${ns}/`))) return false;
  return !policy.documentationUrls.some((d) => url.startsWith(d.prefix));
}

function checkCode(p: Parsed, ctx: ReturnType<typeof index>, policy: EgressPolicy): void {
  const visit = (node: Node) => {
    for (const child of children(node)) visit(child); // children first: a URL argument before its call
    if (node.type === "Literal" && typeof node.value === "string") checkString(node.value, node.start, p, policy);
    if (node.type === "TemplateElement") checkString(String(node.value.cooked ?? ""), node.start, p, policy);
    if (node.type === "CallExpression" || node.type === "NewExpression") checkCall(node, p, ctx);
  };
  visit(p.program);
}

function checkString(text: string, offset: number, p: Parsed, policy: EgressPolicy): void {
  for (const m of text.matchAll(URL_IN_TEXT)) {
    if (isExternal(m[0], policy)) p.add(offset, "url", `hard-coded external URL ${m[0]}`);
  }
  if (PROTOCOL_RELATIVE.test(text)) p.add(offset, "url", `protocol-relative URL ${text.slice(0, 80)}`);
}

function checkCall(node: Node, p: Parsed, ctx: ReturnType<typeof index>): void {
  const name = calleeName(node);
  if (name === undefined) return;
  if (node.type === "NewExpression" && name === "XMLHttpRequest") {
    p.add(node.start, "xhr", "XMLHttpRequest is not allowed; use fetch with a relative URL");
  } else if (node.type === "CallExpression" && name === "sendBeacon") {
    p.add(node.start, "beacon", "navigator.sendBeacon is not allowed");
  } else if ((node.type === "CallExpression" ? URL_CALLS : URL_CONSTRUCTORS).has(name)) {
    const arg = (node.arguments as Node[])[0];
    const vals = arg === undefined ? undefined : resolve(arg, p, ctx);
    if (!allLocal(vals)) p.add(node.start, "fetch", `${name} to a URL not shown to be local: ${show(vals)}`);
  }
}

/** True when every possible value is a relative URL or a loopback one. `undefined` (a throw, no request) is fine. */
export function allLocal(vals: Vals): boolean {
  return vals?.every((v) => v === "undefined" || (typeof v === "object" && "s" in v && isLocal(v))) === true;
}

function isLocal({ s, exact }: { s: string; exact: boolean }): boolean {
  if (LOOPBACK.test(s)) return exact || /^[a-z]+:\/\/[^/?#]+[:/?#]/i.test(s);
  if (s.startsWith("//") || SCHEME.test(s)) return false;
  // A prefix of unknown length: a scheme or a second slash could follow it, unless a path has already begun.
  return exact || /^(?:\/[^/]|\.\.?\/|[^:/?#]+[/?#]|[?#])/.test(s);
}

export function show(vals: Vals): string {
  if (vals === undefined) return "unknown";
  return vals
    .map((v: Val) =>
      typeof v === "object" && "s" in v
        ? JSON.stringify(v.s) + (v.exact ? "" : "…")
        : String(typeof v === "object" ? "array" : v),
    )
    .join(" | ");
}

/** The AST of `text`, or the parser's message when it does not parse. The extension of `path` picks the syntax. */
function parse(path: string, text: string): Node | string {
  const ext = posix.extname(path);
  const lang = ext === ".tsx" ? "tsx" : ext === ".jsx" ? "jsx" : /^\.[mc]?js$/.test(ext) ? "js" : "ts";
  try {
    return parseAst(text, { lang }) as unknown as Node;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
