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

  test("an awaited value is followed", () => {
    expect(js('async function base() { return "/api/"; }\nfetch(`${await base()}x`);\n')).toEqual([]);
  });

  test("XMLHttpRequest and sendBeacon are always findings", () => {
    expect(js('const x = new XMLHttpRequest();\nnavigator.sendBeacon("/api/x", d);\n')).toEqual([
      "engine/engine.js:1 xhr",
      "engine/engine.js:2 beacon",
    ]);
  });
});

describe("Node and Bun network modules", () => {
  test("a network module is a finding, however it is loaded", () => {
    const text = [
      'import { connect } from "node:net";',
      'import https from "https";',
      'const d = await import("node:dgram");',
      'const t = require("tls");',
      'const dns = process.getBuiltinModule("node:dns/promises");',
      'export * from "node:http2";',
    ].join("\n");
    expect(js(text)).toEqual([1, 2, 3, 4, 5, 6].map((n) => `engine/engine.js:${n} module`));
  });

  test("built-ins without network access, relative chunks and type imports are fine", () => {
    const text =
      'import { readFileSync } from "node:fs";\nimport { Database } from "bun:sqlite";\nimport type { A } from "x";\nconst m = await import("./engine-node-driver.js");\n';
    expect(check({ "engine/engine.ts": text })).toEqual([]);
  });

  test("a module name that is not a literal is a finding", () => {
    expect(js("const m = await import(name);\nconst r = require(other);\n")).toEqual([
      "engine/engine.js:1 dynamic",
      "engine/engine.js:2 dynamic",
    ]);
  });

  test("a package import is a finding: shipped code is bundled; the mod may import claude-code", () => {
    expect(js('import React from "react";\n')).toEqual(["engine/engine.js:1 package"]);
    expect(check({ "src/live.ts": 'import { atom } from "claude-code";\n' })).toEqual([]);
  });

  test("node:http may request only loopback hosts", () => {
    const ok = 'import { request as r } from "node:http";\nr({ host: "127.0.0.1", port, path: "/health" });\n';
    expect(js(ok)).toEqual([]);
    expect(js('import { request } from "node:http";\nrequest({ hostname: "example.com" });\nrequest(opts);\n')).toEqual(
      ["engine/engine.js:2 http-client", "engine/engine.js:3 http-client"],
    );
    expect(js('import * as http from "node:http";\nhttp.get(`http://${h}/`);\n')).toEqual([
      "engine/engine.js:2 http-client",
    ]);
  });

  test("a server from node:http must listen on loopback", () => {
    const head = 'import { createServer } from "node:http";\nconst server = createServer(handle);\n';
    expect(js(`${head}server.listen(0, "127.0.0.1", ready);\n`)).toEqual([]);
    expect(js(`${head}server.listen(4747);\nserver.listen({ port: 0, host: "0.0.0.0" });\n`)).toEqual([
      "engine/engine.js:3 listen",
      "engine/engine.js:4 listen",
    ]);
  });

  test("Bun's network and process APIs and native bindings are findings", () => {
    expect(js('Bun.connect({ hostname: "x" });\nBun.serve({ fetch });\nprocess.binding("tcp_wrap");\n')).toEqual([
      "engine/engine.js:1 bun",
      "engine/engine.js:2 bun",
      "engine/engine.js:3 native",
    ]);
  });
});

describe("child processes", () => {
  const policy: EgressPolicy = {
    ...POLICY,
    commands: [
      { argv: ["open", null], reason: "opens the viewer" },
      { argv: ["xdg-open", null], reason: "opens the viewer" },
      { argv: ["rundll32", "url.dll,FileProtocolHandler", null], reason: "opens the viewer" },
      { argv: [["node", "bun"], "--version"], reason: "finds a runtime" },
    ],
  };
  const cp = (text: string) =>
    check({ "engine/engine.js": `import { exec, execFile, spawn } from "node:child_process";\n${text}` }, policy);

  test("the runtime itself may run a shipped script, but not evaluate code", () => {
    expect(cp("spawn(process.execPath, [...flags, SQL_CHILD, String(ms)]);\n")).toEqual([]);
    expect(cp('spawn(process.execPath, ["-e", code]);\n')).toEqual(["engine/engine.js:2 process"]);
  });

  test("an allowlisted command passes; any other, a shell, or an unknown one is a finding", () => {
    expect(cp('execFile("open", [url], { shell: false });\n')).toEqual([]);
    expect(
      cp('execFile("curl", [url]);\nexec("ls");\nspawn(cmd, []);\nspawn("open", [u], { shell: true });\n'),
    ).toEqual([
      "engine/engine.js:2 process",
      "engine/engine.js:3 process",
      "engine/engine.js:4 process",
      "engine/engine.js:5 process",
    ]);
  });

  test("a command and its arguments destructured from one call are checked together", () => {
    const opener = [
      "function openerFor(platform, url) {",
      '  if (platform === "darwin") return ["open", [url]];',
      '  if (platform === "win32") return ["rundll32", ["url.dll,FileProtocolHandler", url]];',
      '  return ["xdg-open", [url]];',
      "}",
      "const [command, args] = openerFor(process.platform, url);",
      "execFile(command, args, { shell: false });",
    ].join("\n");
    expect(cp(opener)).toEqual([]);
  });
});

describe("the mod's $ API", () => {
  const policy: EgressPolicy = {
    ...POLICY,
    commands: [
      { argv: [["node", "bun"], "--version"], reason: "finds a runtime" },
      { argv: [["open", "xdg-open"], null], reason: "opens the viewer" },
    ],
  };
  const mod = (text: string) => check({ "src/viewer.ts": text }, policy);

  test("$.process.run is checked through its helper's call sites", () => {
    const helper =
      "async function tryRun($: E, argv: string[]) { return await $.process.run(argv, { timeoutMs: 5 }); }\n";
    const opener = 'const opener = os === "Darwin" ? "open" : os === "Linux" ? "xdg-open" : undefined;\n';
    expect(mod(`${helper}${opener}await tryRun($, ["node", "--version"]);\nawait tryRun($, [opener, url]);\n`)).toEqual(
      [],
    );
    expect(mod(`${helper}await tryRun($, ["curl", url]);\n`)).toEqual(["src/viewer.ts:1 process"]);
  });

  test("an argument from a function that may return undefined matches its rule", () => {
    const text = [
      'async function findRuntime() { if (a) return "node"; if (b) return "bun"; return undefined; }',
      "const runtime = await findRuntime();",
      'await $.process.run(["node", runtime === undefined ? "--version" : "--version"]);',
      'await $.process.run([runtime, "--version"]);',
    ].join("\n");
    expect(mod(text)).toEqual([]);
  });

  test("APIs that reach the network or the model are findings", () => {
    const text =
      '$.telemetry.log({ to: "anthropic" });\nawait $.mcp.call("s", "t", {});\n$.audio.play(u);\nconst { http } = $;\n';
    expect(mod(text)).toEqual([
      "src/viewer.ts:1 mod-api",
      "src/viewer.ts:2 mod-api",
      "src/viewer.ts:3 mod-api",
      "src/viewer.ts:4 mod-api",
    ]);
  });

  test("$ in a bundle is a minified name, not the mod API", () => {
    expect(js("$.telemetry.log(x);\n")).toEqual([]);
  });
});
