/**
 * The `qx` command: ingest the transcripts, and read the store through the query layer (or SQL, read-only).
 * `main` takes its arguments and I/O from the caller, so tests run it in-process. Exit codes are in `EXIT`.
 */
import { parseArgs } from "node:util";
import type { DemoOptions, SessionKey } from "@quantext/shared";
import packageJson from "../../package.json" with { type: "json" };
import { claudeCodeCodec } from "../adapters/claude-code/index.ts";
import { claudeConfigDir, createIngest } from "../ingest/index.ts";
import type { Query } from "../query/index.ts";
import { createQuery, createRedactor, installViews, runSql, SqlRejectedError } from "../query/index.ts";
import type { SqlDriver } from "../store/index.ts";
import { defaultDataDir, openReader, openStore, SCHEMA_VERSION, StoreLockedError } from "../store/index.ts";
import { printCall, printReport, printSession, printSessions, printSql } from "./print.ts";

/** 0: done. 1: failed (no store, a store or SQL error). 2: wrong use (arguments, a rejected statement). 3: not found. */
export const EXIT = { ok: 0, failed: 1, usage: 2, notFound: 3 } as const;

export interface CliIo {
  stdout(text: string): void;
  stderr(text: string): void;
  env: Readonly<Record<string, string | undefined>>;
  home: string;
  /** The user name, hidden in demo mode. */
  user?: string;
}

export const USAGE = `qx: what the model received on every call, from the local session logs.

Usage:
  qx ingest [--root <dir>]                      Read new transcript bytes into the store
  qx sessions [--project <p>] [--search <s>] [--sort ended|started|cost|calls] [--limit <n>] [--offset <n>]
  qx session <id>                               A Session: lanes, compactions, events, subagents
  qx call <session> <n> [--lane <lane>] [--diff]
                                                The context of Call n (its index in the Session; with --lane, the
                                                n-th Call of that lane), and with --diff its change from the last
  qx sql "<select>" [--limit <n>]               One read-only statement over the tables and views
  qx report                                     What ingest could not read or map, and the Calls' issues
  qx --version | --help

Options for every command:
  --data-dir <dir>      The store's folder (default ~/.quantext)
  --json                JSON output: the query layer's response types (docs/cli.md)
  --demo                Demo mode: hide local paths
  --demo-project <p>    Demo mode with only these projects (by exact path; repeat for more)

Exit codes: 0 done, 1 failed, 2 wrong use, 3 not found.`;

class UsageError extends Error {}
class NotFoundError extends Error {}

const OPTIONS = {
  "data-dir": { type: "string" },
  root: { type: "string" },
  json: { type: "boolean" },
  demo: { type: "boolean" },
  "demo-project": { type: "string", multiple: true },
  project: { type: "string" },
  search: { type: "string" },
  sort: { type: "string" },
  limit: { type: "string" },
  offset: { type: "string" },
  lane: { type: "string" },
  diff: { type: "boolean" },
  version: { type: "boolean" },
  help: { type: "boolean", short: "h" },
} as const;

type Values = ReturnType<typeof parse>["values"];

function parse(argv: readonly string[]) {
  return parseArgs({ args: [...argv], options: OPTIONS, allowPositionals: true, strict: true });
}

/** Run `qx` with these arguments; returns the exit code. */
export async function main(argv: readonly string[], given: CliIo): Promise<number> {
  const io = inDemo(argv) ? redactedErrors(given) : given;
  try {
    let parsed: ReturnType<typeof parse>;
    try {
      parsed = parse(argv);
    } catch (error) {
      throw new UsageError(error instanceof Error ? error.message : String(error));
    }
    const { values, positionals } = parsed;
    if (values.version === true) {
      io.stdout(`qx ${packageJson.version} (store schema ${SCHEMA_VERSION})\n`);
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
    const run = COMMANDS[command];
    if (run === undefined) throw new UsageError(`unknown command: ${command}`);
    const db = await openReader(dataDir, { setup: installViews });
    try {
      const query = createQuery({
        db,
        codec: claudeCodeCodec,
        ...demoOf(values),
        home: io.home,
        ...(io.user === undefined ? {} : { user: io.user }),
      });
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
  sql({ values, args, db, io }) {
    arity(args, 1, 'sql "<select>"');
    if (demoOf(values).demo !== undefined) {
      throw new UsageError("qx sql reads the tables as they are: it does not run in demo mode");
    }
    const result = runSql(db, args[0] ?? "", { limit: integer(values.limit, "--limit") ?? 1000 });
    io.stdout(values.json === true ? json(result) : printSql(result));
    return EXIT.ok;
  },
  report({ values, args, query, io }) {
    arity(args, 0, "report");
    const report = query.ingestReport();
    io.stdout(values.json === true ? json(report) : printReport(report));
    return EXIT.ok;
  },
};

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

/** Demo mode is asked for: known before the arguments are parsed, so that even a parse error is redacted. */
function inDemo(argv: readonly string[]): boolean {
  return argv.some((a) => a === "--demo" || a === "--demo-project" || a.startsWith("--demo-project="));
}

/** The same I/O with local paths and the user name hidden in what goes to stderr. */
function redactedErrors(io: CliIo): CliIo {
  const redact = createRedactor({ home: io.home, ...(io.user === undefined ? {} : { user: io.user }) });
  return { ...io, stderr: (text) => io.stderr(redact(text)) };
}

function demoOf(values: Values): { demo?: DemoOptions } {
  const projects = values["demo-project"];
  if (projects !== undefined) return { demo: { projects, redactPaths: true } };
  return values.demo === true ? { demo: { redactPaths: true } } : {};
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
