// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the fixtures are source code with template literals in it.
import { describe, expect, test } from "vitest";
import type { EgressPolicy } from "./egress.ts";
import { findEgress } from "./egress.ts";

const POLICY: EgressPolicy = {
  documentationUrls: [{ prefix: "https://docs.example.org/", reason: "shown to the user, never fetched" }],
  commands: [],
};

/** Each finding as "<file>:<line> <rule>", in order. */
function check(files: Record<string, string>, policy = POLICY): string[] {
  const list = Object.entries(files).map(([path, text]) => ({ path, text }));
  return findEgress(list, policy).map((f) => `${f.file}:${f.line} ${f.rule}`);
}
const js = (text: string) => check({ "engine/engine.js": text });

describe("hard-coded URLs", () => {
  test("an external URL in a string is a finding; one in a comment is not", () => {
    expect(js('// see https://example.com\nconst u = "https://example.com/x";\n')).toEqual(["engine/engine.js:2 url"]);
  });

  test("loopback URLs are local; a host that only starts like one is not", () => {
    expect(js('const a = "http://127.0.0.1:4747/";\nconst b = `http://localhost:${p}/`;\n')).toEqual([]);
    expect(js('const c = "http://127.0.0.1.example.com/";\n')).toEqual(["engine/engine.js:1 url"]);
  });

  test("a documentation URL on the allowlist is not a finding", () => {
    expect(js('const d = "https://docs.example.org/pricing";\n')).toEqual([]);
  });

  test("a URL whose host is an expression is left to the fetch rule", () => {
    expect(js("const o = `http://${host}`;\n")).toEqual([]);
  });

  test("a protocol-relative URL in a string is a finding", () => {
    expect(js('const s = "//cdn.example.com/lib.js";\n')).toEqual(["engine/engine.js:1 url"]);
  });

  test("HTML, CSS and JSON files are scanned as text", () => {
    const files = {
      "engine/web/index.html": '<link href="/a.css">\n<script src="https://cdn.example.com/x.js"></script>\n',
      "engine/web/assets/a.css": "body{}\n@import url(//fonts.example.com/f.css);\n",
      "engine/package.json": '{ "homepage": "https://example.com" }\n',
    };
    expect(check(files)).toEqual([
      "engine/package.json:1 url",
      "engine/web/assets/a.css:2 url",
      "engine/web/index.html:2 url",
    ]);
  });

  test("XML namespace URIs are names, not addresses", () => {
    expect(js('const n = "http://www.w3.org/2000/svg";\n')).toEqual([]);
  });

  test("files that are not code or markup are not scanned", () => {
    expect(
      check({ LICENSE: "http://www.apache.org/licenses/\n", "engine/engine.js.map": '"https://x.example"' }),
    ).toEqual([]);
  });

  test("a file that does not parse is a finding", () => {
    expect(js("const = ;\n")).toEqual(["engine/engine.js:1 parse"]);
  });
});

describe("fetch, EventSource, WebSocket", () => {
  test("a relative URL is local", () => {
    expect(js('fetch("/api/v1/sessions");\nfetch(`/api/v1/sessions/${id}`);\nfetch("/api/" + e);\n')).toEqual([]);
    expect(js('new EventSource(`/api/v1/events?cursor=${c}`);\nwindow.fetch("api/v1/x");\n')).toEqual([]);
  });

  test("an external or unknown URL is a finding", () => {
    expect(js('fetch("https://example.com/collect");\n')).toEqual([
      "engine/engine.js:1 url",
      "engine/engine.js:1 fetch",
    ]);
    expect(js("fetch(url);\n")).toEqual(["engine/engine.js:1 fetch"]);
    expect(js('fetch("ht" + "tps://example.com");\n')).toEqual(["engine/engine.js:1 fetch"]);
    expect(js("fetch(`//${h}/x`);\n")).toEqual(["engine/engine.js:1 fetch"]);
    expect(js("new WebSocket(`ws://${host}/`);\n")).toEqual(["engine/engine.js:1 fetch"]);
  });

  test("a loopback URL is local only up to a delimiter after the host", () => {
    expect(js("fetch(`http://127.0.0.1:${port}/health`);\n")).toEqual([]);
    expect(js("fetch(`http://127.0.0.1${rest}`);\n")).toEqual(["engine/engine.js:1 fetch"]);
  });

  test("a parameter is resolved from every call site of its function", () => {
    const helper = "function get(path) { return fetch(path); }\n";
    expect(js(`${helper}get("/api/a");\nget(\`/api/\${b}\`);\n`)).toEqual([]);
    expect(js(`${helper}get("/api/a");\nget(other);\n`)).toEqual(["engine/engine.js:1 fetch"]);
    expect(js("const get = (p) => fetch(p, { cache: 'no-store' });\nget('/health');\n")).toEqual([]);
  });

  test("constants, conditionals and URL builders are followed, also across files", () => {
    expect(js('const base = "/api/v1/";\nconst u = ok ? `${base}a` : base + "b";\nfetch(u);\n')).toEqual([]);
    const files = {
      "src/engine-file.ts":
        "export function engineUrl(port: number): string {\n  return `http://127.0.0.1:${port}/`;\n}\n",
      "src/viewer.ts": "await $.http.fetch(`${engineUrl(port)}health`);\n",
    };
    expect(check(files)).toEqual([]);
    const bad = { ...files, "src/other.ts": 'function engineUrl() { return "https://example.com/"; }\n' };
    expect(check(bad)).toEqual(["src/other.ts:1 url", "src/viewer.ts:1 fetch"]);
  });

  test("a value assigned later is also a possible value", () => {
    expect(js('let u = "/a";\nu = "https://example.com";\nfetch(u);\n')).toEqual([
      "engine/engine.js:2 url",
      "engine/engine.js:3 fetch",
    ]);
  });

  test("XMLHttpRequest and sendBeacon are always findings", () => {
    expect(js('const x = new XMLHttpRequest();\nnavigator.sendBeacon("/api/x", d);\n')).toEqual([
      "engine/engine.js:1 xhr",
      "engine/engine.js:2 beacon",
    ]);
  });
});
