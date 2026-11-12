/**
 * `qx serve`, the engine process (ADR 25): one per data folder. It reuses an engine that already runs (found by
 * `engine.json` and its `/health`), else takes the writer lock, serves the API, catches up on what is new, watches
 * the transcripts and passes each change to the event stream. It stops when told (SIGINT, SIGTERM) or, while
 * only a viewer needs it, after an idle time; then it stops the watcher after its batch and removes its file.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { DemoOptions, EngineFile } from "@quantext/shared";
import { claudeCodeCodec } from "../adapters/claude-code/index.ts";
import type { Api } from "../api/index.ts";
import { createApi } from "../api/index.ts";
import type { Watcher } from "../ingest/index.ts";
import { createIngest, watchTranscripts } from "../ingest/index.ts";
import { createQuery, installViews } from "../query/index.ts";
import type { SqlDriver, Store } from "../store/index.ts";
import { openReader, openStore, StoreLockedError } from "../store/index.ts";
import { engineUrl, readEngineFile, removeEngineFile, writeEngineFile } from "./engine-file.ts";
import { openUrl } from "./open-url.ts";
import { probeHealth } from "./probe.ts";

const API_VERSION = 1;
/** The engine's port when it is free (ADR 25); else any free port, named in `engine.json`. */
export const DEFAULT_PORT = 4747;
export const DEFAULT_IDLE_MINUTES = 10;

export interface ServeOptions {
  dataDir: string;
  root: string;
  version: string;
  /** Set by `--port`: this port or fail. Unset: `DEFAULT_PORT`, else a free one. */
  port?: number;
  demo?: DemoOptions;
  /** `while-viewer`: stop after `idleMinutes` with no event stream and no request. `always`: never. */
  live: "always" | "while-viewer";
  idleMinutes: number;
  open: boolean;
  home: string;
  user?: string;
  host?: string;
}

/** What the process gives the engine; tests pass their own. */
export interface ServeHooks {
  out(text: string): void;
  err(text: string): void;
  /** Stops the engine; by default SIGINT or SIGTERM. */
  signal?: AbortSignal;
  now?: () => number;
  /** How often to check for the idle time (default 15 s). */
  idleCheckMs?: number;
  openUrl?: (url: string) => void;
  staticDir?: string;
  defaultPort?: number;
  /** How long a start that finds the store locked waits for the other engine to answer (default 5 s). */
  lockWaitMs?: number;
}

type Running = { kind: "same"; file: EngineFile } | { kind: "other"; file: EngineFile; version: string };

/** An engine that answers at the port `engine.json` names, with the pid it names. */
async function running(dataDir: string, version: string): Promise<Running | undefined> {
  const file = readEngineFile(dataDir);
  if (file === undefined) return undefined;
  const health = await probeHealth(file.port);
  if (health === undefined || health.pid !== file.pid) return undefined; // stale: that engine is gone
  return health.version === version && health.apiVersion === API_VERSION
    ? { kind: "same", file }
    : { kind: "other", file, version: health.version };
}

/** Run the engine until it is stopped; returns the exit code. */
export async function serve(options: ServeOptions, hooks: ServeHooks): Promise<number> {
  const { dataDir, version } = options;
  const now = hooks.now ?? Date.now;
  const open = (url: string) =>
    (hooks.openUrl ?? ((u: string) => openUrl(u, (e) => hooks.err(`qx: could not open the browser: ${e.message}\n`))))(
      url,
    );

  /** Another engine answers: reuse it (0), or say why not (1). */
  const reuse = (found: Running): number => {
    if (found.kind === "other") {
      hooks.err(
        `qx: an engine of version ${found.version} (pid ${found.file.pid}) runs at ${found.file.url}; this is ` +
          `version ${version}. Stop it first (kill ${found.file.pid}).\n`,
      );
      return 1;
    }
    hooks.out(`quantext engine already runs at ${found.file.url} (pid ${found.file.pid})\n`);
    if (options.open) open(found.file.url);
    return 0;
  };

  const before = await running(dataDir, version);
  if (before !== undefined) return reuse(before);

  let store: Store;
  try {
    store = await openStore({ dataDir });
  } catch (error) {
    if (!(error instanceof StoreLockedError)) throw error;
    // Another engine is starting, or `qx ingest` runs: wait a little for an engine to answer.
    const until = now() + (hooks.lockWaitMs ?? 5000);
    while (now() < until) {
      const found = await running(dataDir, version);
      if (found !== undefined) return reuse(found);
      await new Promise((r) => setTimeout(r, 100));
    }
    hooks.err(`qx: ${error.message}\n`);
    return 1;
  }

  const stopping = new AbortController();
  const stopSignal = hooks.signal ?? processSignal(stopping);
  const startedAt = new Date(now()).toISOString();
  let reader: SqlDriver | undefined;
  let api: Api | undefined;
  let watcher: Watcher | undefined;
  let idle: ReturnType<typeof setInterval> | undefined;
  let catchUp: Promise<unknown> = Promise.resolve();
  try {
    reader = await openReader(dataDir, { setup: installViews });
    const query = createQuery({
      db: reader,
      codec: claudeCodeCodec,
      home: options.home,
      ...(options.demo === undefined ? {} : { demo: options.demo }),
      ...(options.user === undefined ? {} : { user: options.user }),
      ...(options.host === undefined ? {} : { host: options.host }),
    });
    const ingest = createIngest({ store, root: options.root });
    const engineApi = createApi({
      query,
      now,
      staticDir: hooks.staticDir ?? defaultStaticDir(),
      info: { version, pid: process.pid, startedAt, demo: options.demo !== undefined, dataDir },
      onError: (e) => hooks.err(`qx: ${e instanceof Error ? e.message : String(e)}\n`),
    });
    api = engineApi;
    ingest.onEvent((event) => engineApi.publish(event));
    const port = await listen(engineApi, options.port, hooks.defaultPort ?? DEFAULT_PORT);
    const url = engineUrl(port);
    writeEngineFile(dataDir, { apiVersion: API_VERSION, version, pid: process.pid, port, url, startedAt });
    hooks.out(`quantext engine at ${url} (pid ${process.pid})\n`);
    if (options.open) open(url);

    const stopped = new Promise<string>((resolve) => {
      const done = (why: string) => {
        stopping.abort();
        resolve(why);
      };
      if (stopSignal.aborted) done("stopped");
      stopSignal.addEventListener("abort", () => done("stopped"), { once: true });
      if (options.live === "while-viewer") {
        const idleMs = options.idleMinutes * 60_000;
        idle = setInterval(() => {
          const { streams, lastActive } = engineApi.activity();
          if (streams === 0 && now() - lastActive >= idleMs) done(`idle for ${options.idleMinutes} min`);
        }, hooks.idleCheckMs ?? 15_000);
      }
    });

    // Catch up, then watch; a stop ends the pass after its batch, and the next start goes on from there.
    catchUp = ingest.ingestAll({ signal: stopping.signal }).then((summary) => {
      for (const e of summary.errors) hooks.err(`qx: ${e.path}: ${e.error}\n`);
      if (!stopping.signal.aborted) {
        watcher = watchTranscripts({
          ingest,
          root: options.root,
          onError: (e) => hooks.err(`qx: live ingest failed: ${e instanceof Error ? e.message : String(e)}\n`),
        });
      }
    });
    catchUp.catch((e: unknown) => hooks.err(`qx: ingest failed: ${e instanceof Error ? e.message : String(e)}\n`));
    const why = await stopped;
    hooks.out(`quantext engine stopping (${why})\n`);
    return 0;
  } finally {
    clearInterval(idle);
    stopping.abort();
    await catchUp.catch(() => undefined); // reported above
    await watcher?.stop();
    await api?.close();
    reader?.close();
    store.close();
    removeEngineFile(dataDir, process.pid);
  }
}

/** Listen on the asked port, or on the default port, else on any free one. */
async function listen(api: Api, asked: number | undefined, fallback: number): Promise<number> {
  const inUse = (error: unknown) => (error as NodeJS.ErrnoException).code === "EADDRINUSE";
  try {
    return await api.listen(asked ?? fallback);
  } catch (error) {
    if (!inUse(error)) throw error;
    if (asked !== undefined) throw new Error(`port ${asked} is in use (--port)`);
    return api.listen(0);
  }
}

/** Abort on SIGINT or SIGTERM; a second signal ends the process at once. */
function processSignal(controller: AbortController): AbortSignal {
  const signals = ["SIGINT", "SIGTERM"] as const;
  const onSignal = () => {
    if (controller.signal.aborted) process.exit(130);
    controller.abort();
  };
  for (const s of signals) process.on(s, onSignal);
  controller.signal.addEventListener("abort", () => {
    // Keep the handlers a moment longer, so that a second signal still ends the process.
    setTimeout(() => {
      for (const s of signals) process.off(s, onSignal);
    }, 10_000).unref();
  });
  return controller.signal;
}

/** The viewer's files: `web/` next to the bundled engine, else the placeholder folder in the repo. */
export function defaultStaticDir(): string {
  for (const candidate of ["./web/", "../../static/"]) {
    const dir = fileURLToPath(new URL(candidate, import.meta.url));
    if (existsSync(`${dir}index.html`)) return dir;
  }
  throw new Error("the viewer's files are missing (no web/index.html next to the engine)");
}
