import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { trapEnv } from "./egress-trap-env.ts";

const work = mkdtempSync(join(tmpdir(), "qx-trap-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

/** Run `code` as a module on this runtime with the trap preloaded; the trap's log lines as "kind target". */
function trapped(code: string): string[] {
  const script = join(work, `probe-${Math.random().toString(36).slice(2)}.mjs`);
  const log = `${script}.log`;
  writeFileSync(script, code);
  writeFileSync(log, "");
  execFileSync(process.execPath, [script], { env: { ...process.env, ...trapEnv(log) }, stdio: "pipe" });
  return readFileSync(log, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const { kind, target } = JSON.parse(line) as { kind: string; target: string };
      return `${kind} ${target}`;
    });
}

const attempt = (expr: string) => `try { await ${expr}; } catch {}\n`;

test("the trap records and refuses fetch, sockets and DNS to other hosts", () => {
  const code = [
    attempt('fetch("http://example.invalid/collect")'),
    attempt('import("node:net").then((net) => net.connect(9, "203.0.113.1"))'),
    attempt('import("node:dns/promises").then((dns) => dns.lookup("example.invalid"))'),
  ].join("");
  expect(trapped(code)).toEqual([
    "fetch example.invalid",
    "net.connect 203.0.113.1:9",
    "dns.promises.lookup example.invalid",
  ]);
});

test("the trap lets loopback through", () => {
  const code = [
    'import { createServer, get } from "node:http";',
    "const server = createServer((_, res) => res.end('ok')).listen(0, '127.0.0.1');",
    "await new Promise((r) => server.once('listening', r));",
    "const { port } = server.address();",
    "await new Promise((r) => get({ host: '127.0.0.1', port, path: '/' }, (res) => res.resume().on('end', r)));",
    "await (await fetch(`http://127.0.0.1:${port}/`)).text();",
    "server.close();",
  ].join("\n");
  expect(trapped(code)).toEqual([]);
});

test("the trap reaches child processes of the runtime", () => {
  const child = join(work, "child.mjs");
  writeFileSync(child, attempt('fetch("http://example.invalid/child")'));
  const code = `import { execFileSync } from "node:child_process";\nexecFileSync(process.execPath, [${JSON.stringify(child)}]);\n`;
  expect(trapped(code)).toEqual(["fetch example.invalid"]);
});
