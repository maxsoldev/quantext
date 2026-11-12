/**
 * The `qx` command: ingest the transcripts, and read the store through the query layer (or SQL, read-only).
 * `main` takes its arguments and I/O from the caller, so tests run it in-process. Exit codes are in `EXIT`.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { LifetimeOptions, SessionKey, SqlResult } from "@quantext/shared";
import { claudeCodeCodec } from "../adapters/claude-code/index.ts";
import { claudeConfigDir, createIngest } from "../ingest/index.ts";
import type { Query } from "../query/index.ts";
import { createQuery, installViews, SqlRejectedError } from "../query/index.ts";
import type { SqlDriver } from "../store/index.ts";
import { defaultDataDir, openReader, openStore, SCHEMA_VERSION, StoreLockedError } from "../store/index.ts";
import {
  printBlockLifetimes,
  printCall,
  printReport,
  printSession,
  printSessions,
  printSql,
  printToolOutputs,
} from "./print.ts";
import type { ServeHooks } from "./serve.ts";
import { DEFAULT_IDLE_MINUTES, DEFAULT_PORT, serve } from "./serve.ts";
import { VERSION } from "./version.ts";

/** 0: done. 1: failed (no store, a store or SQL error). 2: wrong use (arguments, a rejected statement). 3: not found. */
export const EXIT = { ok: 0, failed: 1, usage: 2, notFound: 3 } as const;

export interface CliIo {
  stdout(text: string): void;
  stderr(text: string): void;
  env: Readonly<Record<string, string | undefined>>;
  home: string;
  /** `qx serve`: a stop signal, a clock, a browser opener and more, in place of the process's own (tests). */
  serve?: Omit<ServeHooks, "out" | "err">;
}

export const USAGE = `qx: what the model received on every call, from the local session logs.

Usage:
  qx ingest [--root <dir>]                      Read new transcript bytes into the store
  qx sessions [--project <p>] [--search <s>] [--sort ended|started|cost|calls] [--limit <n>] [--offset <n>]
  qx session <id>                               A Session: lanes, compactions, events, subagents
  qx call <session> <n> [--lane <lane>] [--diff]
                                                The context of Call n (its index in the Session; with --lane, the
                                                n-th Call of that lane), and with --diff its change from the last
  qx outputs <session> [--sort cost|tokens|calls] [--limit <n>]
                                                The Session's tool outputs by lifetime cost
  qx blocks <session> [--sort cost|tokens|calls] [--limit <n>]
                                                The Session's Blocks by lifetime cost
  qx sql "<select>" [--limit <n>] [--timeout <s>]
                                                One read-only statement over the tables and views, in its own
                                                process, stopped after --timeout seconds (default 30)
  qx report                                     What ingest could not read or map, and the Calls' issues
  qx serve [--root <dir>] [--port <n>] [--live while-viewer|always] [--idle-minutes <n>] [--open]
                                                The engine: the viewer and the HTTP API on 127.0.0.1 (port
                                                ${DEFAULT_PORT}, else a free one), live ingest; reuses a running
                                                engine. Stops after --idle-minutes (default ${DEFAULT_IDLE_MINUTES}) with
                                                no viewer, unless --live always
  qx --version | --help

Options for every command:
  --data-dir <dir>      The store's folder (default ~/.quantext)
  --json                JSON output: the query layer's response types (docs/cli.md)

Exit codes: 0 done, 1 failed, 2 wrong use, 3 not found.`;

class UsageError extends Error {}
class NotFoundError extends Error {}

const OPTIONS = {
  "data-dir": { type: "string" },
  root: { type: "string" },
  json: { type: "boolean" },
  project: { type: "string" },
  search: { type: "string" },
  sort: { type: "string" },
  limit: { type: "string" },
  offset: { type: "string" },
  lane: { type: "string" },
  diff: { type: "boolean" },
  timeout: { type: "string" },
  port: { type: "string" },
  live: { type: "string" },
  "idle-minutes": { type: "string" },
  open: { type: "boolean" },
  version: { type: "boolean" },
  help: { type: "boolean", short: "h" },
} as const;

type Values = ReturnType<typeof parse>["values"];

function parse(argv: readonly string[]) {
  return parseArgs({ args: [...argv], options: OPTIONS, allowPositionals: true, strict: true });
}

/** Run `qx` with these arguments; returns the exit code. */
export async function main(argv: readonly string[], io: CliIo): Promise<number> {
  try {
    let parsed: ReturnType<typeof parse>;
    try {
      parsed = parse(argv);
    } catch (error) {
      throw new UsageError(error instanceof Error ? error.message : String(error));
    }
    const { values, positionals } = parsed;
    if (values.version === true) {
      io.stdout(`qx ${VERSION} (store schema ${SCHEMA_VERSION})\n`);
      return EXIT.ok;
    }
    if (values.help === true) {
      io.stdout(`${USAGE}\n`);
      return EXIT.ok;
    }
    const [command, ...args] = positionals;
    if (command === undefined) throw new UsageError("no command given");
    const dataDir = values["data-dir"] ?? defaultDataDir(io.home);
    if (command === "ingest") return await ingest(values, args, dataDir, io);
    if (command === "sql") return await sql(values, args, dataDir, io);
    if (command === "serve") return await serveCommand(values, args, dataDir, io);
    const run = COMMANDS[command];
    if (run === undefined) throw new UsageError(`unknown command: ${command}`);
    const db = await openReader(dataDir, { setup: installViews });
    try {
      const query = createQuery({ db, codec: claudeCodeCodec });
      return run({ values, args, query, db, io });
    } finally {
      db.close();
    }
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr(`qx: ${error.message}\n\n${USAGE}\n`);
      return EXIT.usage;
    }
    if (error instanceof SqlRejectedError) {
      io.stderr(`qx: ${error.message}\n`);
      return EXIT.usage;
    }
    if (error instanceof NotFoundError) {
      io.stderr(`qx: ${error.message}\n`);
      return EXIT.notFound;
    }
    io.stderr(`qx: ${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT.failed;
  }
}

interface Context {
  values: Values;
  args: string[];
  query: Query;
  db: SqlDriver;
  io: CliIo;
}

const COMMANDS: Record<string, (c: Context) => number> = {
  sessions({ values, args, query, io }) {
    arity(args, 0, "sessions");
    const sort = values.sort;
    if (sort !== undefined && !["ended", "started", "cost", "calls"].includes(sort)) {
      throw new UsageError(`--sort must be ended, started, cost or calls, not ${sort}`);
    }
    const page = query.listSessions({
      ...(values.project === undefined ? {} : { project: values.project }),
      ...(values.search === undefined ? {} : { search: values.search }),
      ...(sort === undefined ? {} : { sort: sort as "ended" }),
      limit: integer(values.limit, "--limit") ?? 50,
      offset: integer(values.offset, "--offset") ?? 0,
    });
    io.stdout(values.json === true ? json(page) : printSessions(page));
    return EXIT.ok;
  },
  session({ values, args, query, io }) {
    arity(args, 1, "session <id>");
    const detail = query.getSession(resolve(query, args[0] ?? ""));
    if (detail === undefined) throw new NotFoundError(`no session ${args[0]}`);
    io.stdout(values.json === true ? json(detail) : printSession(detail));
    return EXIT.ok;
  },
  call({ values, args, query, io }) {
    arity(args, 2, "call <session> <n>");
    const key = resolve(query, args[0] ?? "");
    const n = integer(args[1], "<n>") ?? 0;
    let index = n;
    if (values.lane !== undefined) {
      const calls = query.listCalls(key, { lane: values.lane });
      const call = calls.items[n];
      if (call === undefined) throw new NotFoundError(`lane ${values.lane} has ${calls.total} calls, no call ${n}`);
      index = call.index;
    }
    const context = query.contextAt(key, index);
    if (context === undefined) throw new NotFoundError(`session ${key.id} has no call ${index}`);
    const diff = values.diff === true ? query.contextDiff(key, index) : undefined;
    io.stdout(
      values.json === true ? json(diff === undefined ? context : { ...context, diff }) : printCall(context, diff),
    );
    return EXIT.ok;
  },
  outputs({ values, args, query, io }) {
    arity(args, 1, "outputs <session>");
    const list = query.toolOutputs(resolve(query, args[0] ?? ""), lifetimeOptions(values));
    io.stdout(values.json === true ? json(list) : printToolOutputs(list.items));
    return EXIT.ok;
  },
  blocks({ values, args, query, io }) {
    arity(args, 1, "blocks <session>");
    const list = query.blockLifetimes(resolve(query, args[0] ?? ""), lifetimeOptions(values));
    io.stdout(values.json === true ? json(list) : printBlockLifetimes(list.items));
    return EXIT.ok;
  },
  report({ values, args, query, io }) {
    arity(args, 0, "report");
    const report = query.ingestReport();
    io.stdout(values.json === true ? json(report) : printReport(report));
    return EXIT.ok;
  },
};

/** In the repo the files are `.ts`; in the bundle (`dist/`), each entry is a `.js` file next to the engine. */
const EXT = import.meta.url.endsWith(".ts") ? "ts" : "js";
const SQL_CHILD = fileURLToPath(new URL(`./sql-child.${EXT}`, import.meta.url));
export const DEFAULT_SQL_TIMEOUT_S = 30;

/** `qx sql`: the statement runs in a child process, killed after the time limit. */
async function sql(values: Values, args: string[], dataDir: string, io: CliIo): Promise<number> {
  arity(args, 1, 'sql "<select>"');
  const limit = integer(values.limit, "--limit") ?? 1000;
  const timeout = integer(values.timeout, "--timeout") ?? DEFAULT_SQL_TIMEOUT_S;
  const reply = await runChild(JSON.stringify({ dataDir, sql: args[0] ?? "", limit }), timeout * 1000);
  if (reply === "timeout") {
    io.stderr(`qx: the query ran longer than ${timeout} s and was stopped (--timeout)\n`);
    return EXIT.failed;
  }
  const parsed = JSON.parse(reply) as { result?: SqlResult; error?: string; rejected?: boolean };
  if (parsed.result === undefined) {
    io.stderr(`qx: ${parsed.error ?? "the query failed"}\n`);
    return parsed.rejected === true ? EXIT.usage : EXIT.failed;
  }
  io.stdout(values.json === true ? json(parsed.result) : printSql(parsed.result));
  return EXIT.ok;
}

/** Run the SQL child with `input` on stdin; its stdout, or "timeout" when it was killed after `ms`. */
function runChild(input: string, ms: number): Promise<string> {
  const flags = process.versions.bun === undefined ? ["--no-warnings"] : [];
  // The child kills itself a little after the parent would, in case the parent cannot (it was killed).
  const child = spawn(process.execPath, [...flags, SQL_CHILD, String(ms + 1000)], { stdio: ["pipe", "pipe", "pipe"] });
  // Ctrl-C or a stop for qx stops the query too.
  const forward = () => child.kill("SIGKILL");
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  for (const signal of signals) process.once(signal, forward);
  const done = () => {
    for (const signal of signals) process.off(signal, forward);
  };
  return new Promise((resolve, reject) => {
    let out = "";
    let err = "";
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      child.kill("SIGKILL");
    }, ms);
    child.stdout.on("data", (d: Buffer) => (out += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (err += d.toString("utf8")));
    child.on("error", (error) => {
      clearTimeout(timer);
      done();
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      done();
      if (signal !== null && !killed) {
        reject(new Error(`the SQL process was stopped (${signal})`));
        return;
      }
      if (killed) resolve("timeout");
      else if (code === 0 && out !== "") resolve(out);
      else reject(new Error(`the SQL process failed (exit ${code}): ${err.trim()}`));
    });
    child.stdin.end(input);
  });
}

async function ingest(values: Values, args: string[], dataDir: string, io: CliIo): Promise<number> {
  arity(args, 0, "ingest");
  const root = values.root ?? claudeConfigDir(io.env, io.home);
  let store: Awaited<ReturnType<typeof openStore>>;
  try {
    store = await openStore({ dataDir });
  } catch (error) {
    if (error instanceof StoreLockedError) {
      io.stderr(`qx: ${error.message}\n`);
      return EXIT.failed;
    }
    throw error;
  }
  try {
    const started = performance.now();
    const summary = await createIngest({ store, root }).ingestAll();
    const ms = Math.round(performance.now() - started);
    if (values.json === true) io.stdout(json({ ...summary, ms }));
    else {
      io.stdout(
        `${summary.logs} logs, ${summary.files} files with new bytes, ${summary.bytes} bytes read, ` +
          `${summary.callsAdded} calls added, in ${ms} ms\n`,
      );
    }
    for (const e of summary.errors) io.stderr(`qx: ${e.path}: ${e.error}\n`);
    return EXIT.ok;
  } finally {
    store.close();
  }
}

async function serveCommand(values: Values, args: string[], dataDir: string, io: CliIo): Promise<number> {
  arity(args, 0, "serve");
  const live = values.live ?? "while-viewer";
  if (live !== "while-viewer" && live !== "always") {
    throw new UsageError(`--live must be while-viewer or always, not ${live}`);
  }
  const port = integer(values.port, "--port");
  if (port !== undefined && port > 65_535) throw new UsageError("--port must be from 0 to 65535");
  const idleMinutes = integer(values["idle-minutes"], "--idle-minutes") ?? DEFAULT_IDLE_MINUTES;
  if (idleMinutes < 1) throw new UsageError("--idle-minutes must be at least 1");
  return serve(
    {
      dataDir,
      root: values.root ?? claudeConfigDir(io.env, io.home),
      version: VERSION,
      ...(port === undefined ? {} : { port }),
      live,
      idleMinutes,
      open: values.open === true,
    },
    { out: io.stdout, err: io.stderr, ...io.serve },
  );
}

/** A Session by its id, an id prefix, or `<log>:<id>` where the same id is in more than one log. */
function resolve(query: Query, text: string): SessionKey {
  const at = /^(\d+):(.+)$/.exec(text);
  const found =
    at === null ? query.findSessions(text) : query.findSessions(at[2] ?? "").filter((k) => k.log === Number(at[1]));
  const exact = found.filter((k) => k.id === (at === null ? text : at[2]));
  const matches = exact.length > 0 ? exact : found;
  if (matches.length === 0) throw new NotFoundError(`no session ${text}`);
  if (matches.length > 1) {
    const list = matches.map((k) => `${k.log}:${k.id}`).join(", ");
    throw new UsageError(`${text} names more than one session: ${list}`);
  }
  return matches[0] as SessionKey;
}

function lifetimeOptions(values: Values): LifetimeOptions {
  const sort = values.sort;
  if (sort !== undefined && !["cost", "tokens", "calls"].includes(sort)) {
    throw new UsageError(`--sort must be cost, tokens or calls, not ${sort}`);
  }
  return {
    ...(sort === undefined ? {} : { sort: sort as "cost" }),
    limit: integer(values.limit, "--limit") ?? 20,
  };
}

function arity(args: readonly string[], n: number, usage: string): void {
  if (args.length !== n) throw new UsageError(`usage: qx ${usage}`);
}

function integer(text: string | undefined, name: string): number | undefined {
  if (text === undefined) return undefined;
  if (!/^\d+$/.test(text)) throw new UsageError(`${name} must be a whole number, not ${text}`);
  return Number(text);
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
