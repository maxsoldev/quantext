/** The machine beneath the mod for `/quantext view`: files, the engine's port, the commands on PATH, the OS. */
import type { HttpResponse, On, ProcessRunResult } from "claude-code";
import { mock } from "claude-code/testing";
import { toasts } from "./kit.ts";

export const HOME = "/tmp/qx-home";
export const DATA = `${HOME}/.quantext`;
export const VERSION = "0.4.0";

/** What an address answers: a response, a refused connection, or nothing at all (a hung engine). */
export type Answer = HttpResponse | "refused" | "hang";

export const health = (fields: Record<string, unknown> = {}): HttpResponse => ({
  status: 200,
  ok: true,
  headers: { "content-type": "application/json" },
  text: JSON.stringify({ ok: true, version: VERSION, apiVersion: 1, pid: 4242, startedAt: "", demo: false, ...fields }),
});

export const engineFile = (fields: Record<string, unknown> = {}): string =>
  JSON.stringify({ apiVersion: 1, version: VERSION, pid: 4242, port: 4747, url: "http://127.0.0.1:4747/", ...fields });

const ran = (stdout: string, exitCode = 0): ProcessRunResult => ({
  exitCode,
  stdout,
  stderr: "",
  isStdoutTruncated: false,
  isStderrTruncated: false,
});

export interface WorldOptions {
  /** Files by absolute path, beside the bundled engine's package.json (which every world has). */
  files?: Record<string, string>;
  /** What each URL answers; one not listed is refused. Once the engine starts: `afterStart`, and an engine.json. */
  http?: Record<string, Answer>;
  afterStart?: Record<string, Answer>;
  /** Each command's `--version` output; a command not listed is not on PATH. */
  versions?: Record<string, string>;
  /** What `uname -s` prints. */
  os?: string;
  /** Leave out the bundled engine. */
  noEngine?: boolean;
  /** Leave HOME unset. */
  noHome?: boolean;
}

/** Sets up the world and returns what the mod did in it. */
export function world(on: On, options: WorldOptions = {}) {
  const clock = mock.clock(on, { now: 1_000_000 });
  mock.env(on, options.noHome ? {} : { HOME });
  const files = { ...options.files };
  const seen = toasts(on);
  const argvs: string[][] = [];
  const fetched: string[] = [];
  let http = options.http ?? {};
  let root = "";

  on("fs.read", (_$, e) => {
    if (e.path.endsWith("/engine/package.json")) {
      root = e.path.slice(0, -"/engine/package.json".length);
      if (options.noEngine) throw new Error(`ENOENT: ${e.path}`);
      return { value: JSON.stringify({ type: "module", version: VERSION }) };
    }
    const text = files[e.path];
    if (text === undefined) throw new Error(`ENOENT: no such file or directory, open '${e.path}'`);
    return { value: text };
  });
  on("fs.exists", (_$, e) => ({ value: !options.noEngine && e.path.endsWith("/engine/engine.js") }));
  on("http.fetch", async (_$, e) => {
    fetched.push(e.url);
    const answer = http[e.url] ?? "refused";
    if (answer === "refused") throw new Error(`connect ECONNREFUSED ${e.url}`);
    if (answer === "hang") return new Promise<never>(() => undefined); // never settles
    return { value: answer };
  });
  on("process.run", (_$, e) => {
    const argv = [...e.argv];
    argvs.push(argv);
    const [cmd = "", arg] = argv;
    if (cmd === "uname") return { value: ran(`${options.os ?? "Darwin"}\n`) };
    if (cmd === "sh") {
      // the engine writes engine.json once it listens
      files[`${DATA}/engine.json`] = engineFile();
      http = options.afterStart ?? http;
      return { value: ran("") };
    }
    if (cmd === "open" || cmd === "xdg-open") return { value: ran("") };
    const version = options.versions?.[cmd];
    if (version === undefined || arg !== "--version") throw new Error(`spawn ${cmd} ENOENT`);
    return { value: ran(`${version}\n`) };
  });
  on("command.register", (_$, e) => ({ value: { command: e.name } }));

  /** Moves the clock until the flow has settled (it waits at most ~12 s). */
  const settle = async () => {
    for (let i = 0; i < 60; i++) await clock.advance(250);
  };
  return { clock, toasts: seen, argvs, fetched, settle, root: () => root };
}
