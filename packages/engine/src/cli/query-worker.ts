/**
 * A worker thread for the query methods that can take a second on a long Session (lifetimes over every Call),
 * so that the engine's event loop keeps answering meanwhile. It has its own read-only connection and the same
 * query options (demo mode). Messages: `{ id, method, args }` in, `{ id, result }` or `{ id, error }` out.
 */
import { parentPort, workerData } from "node:worker_threads";
import { claudeCodeCodec } from "../adapters/claude-code/index.ts";
import { createQuery, installViews } from "../query/index.ts";
import { openReader } from "../store/index.ts";
import type { OffloadMethod, QueryWorkerOptions } from "./query-worker-pool.ts";
import { OFFLOAD_METHODS } from "./query-worker-pool.ts";

const options = workerData as QueryWorkerOptions;
const port = parentPort;
if (port === null) throw new Error("query-worker runs as a worker thread");
const db = await openReader(options.dataDir, { setup: installViews });
const query = createQuery({
  db,
  codec: claudeCodeCodec,
  ...(options.demo === undefined ? {} : { demo: options.demo }),
  ...(options.home === undefined ? {} : { home: options.home }),
  ...(options.user === undefined ? {} : { user: options.user }),
  ...(options.host === undefined ? {} : { host: options.host }),
});
port.on("message", (message: { id: number; method: OffloadMethod; args: unknown[] }) => {
  const { id, method, args } = message;
  try {
    if (!OFFLOAD_METHODS.includes(method)) throw new Error(`not a method the worker runs: ${String(method)}`);
    const run = query[method] as (...a: unknown[]) => unknown;
    port.postMessage({ id, result: run(...args) });
  } catch (error) {
    port.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
});
port.postMessage({ ready: true });
