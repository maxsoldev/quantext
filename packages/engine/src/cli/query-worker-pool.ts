/**
 * The engine's side of the query worker (`query-worker.ts`): one worker thread, started on first use, that runs
 * the slow query methods, with a time limit per request, a bounded queue, and identical requests shared.
 */
import { Worker } from "node:worker_threads";
import type { Offload } from "../api/index.ts";
import { HttpError } from "../api/index.ts";

export const OFFLOAD_METHODS = ["blockLifetimes", "toolOutputs"] as const;
export type OffloadMethod = (typeof OFFLOAD_METHODS)[number];

export interface QueryWorkerOptions {
  dataDir: string;
}

/** `.ts` in the repo, `.js` in the bundle (`dist/query-worker.js`). */
const EXT = import.meta.url.endsWith(".ts") ? "ts" : "js";

export interface QueryWorkerLimits {
  /** A request not answered in this time fails with 503, and its computation is stopped (default 30 s). */
  timeoutMs?: number;
  /** Requests waiting or running at once; more fail with 503 at once (default 5: one running, four waiting). */
  maxPending?: number;
}

interface Job {
  id: number;
  key: string;
  method: OffloadMethod;
  args: unknown[];
  promise: Promise<unknown>;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer?: ReturnType<typeof setTimeout>;
}

/**
 * The worker runs one request at a time, sent from a queue here, so that a request that runs too long can be
 * stopped (the worker is ended and started again for the next one). Identical requests (method and arguments)
 * share one computation, so two tabs on one Session cost one.
 */
export function createQueryWorker(
  options: QueryWorkerOptions,
  limits: QueryWorkerLimits = {},
): { run: Offload; close(): Promise<void> } {
  const timeoutMs = limits.timeoutMs ?? 30_000;
  const maxPending = limits.maxPending ?? 5;
  let worker: Worker | undefined;
  let next = 0;
  let current: Job | undefined;
  let closing = false;
  const queue: Job[] = [];
  const jobs = new Map<string, Job>();

  const settle = (job: Job) => {
    clearTimeout(job.timer);
    jobs.delete(job.key);
  };
  const fail = (job: Job, error: Error) => {
    settle(job);
    job.reject(error);
  };
  /** End the worker on purpose: its exit is no failure. */
  const end = (w: Worker | undefined) => {
    if (w === undefined) return Promise.resolve();
    if (worker === w) worker = undefined;
    w.removeAllListeners("exit");
    w.removeAllListeners("error");
    return w.terminate().then(() => undefined);
  };
  const started = (): Worker => {
    if (worker !== undefined) return worker;
    const w = new Worker(new URL(`./query-worker.${EXT}`, import.meta.url), { workerData: options });
    w.on("message", (m: { id?: number; result?: unknown; error?: string }) => {
      if (m.id === undefined || current?.id !== m.id) return; // ready, or a request stopped meanwhile
      const job = current;
      current = undefined;
      settle(job);
      if (m.error !== undefined) job.reject(new Error(m.error));
      else job.resolve(m.result);
      pump();
    });
    const broke = (error: Error) => {
      if (worker === w) worker = undefined;
      // It failed by itself: fail what waits too, rather than start it again and again.
      for (const job of [...(current === undefined ? [] : [current]), ...queue.splice(0)]) fail(job, error);
      current = undefined;
    };
    w.on("error", broke);
    w.on("exit", (code) => broke(new Error(`the query worker stopped (exit ${code})`)));
    w.unref();
    worker = w;
    return w;
  };
  const pump = () => {
    if (current !== undefined || closing) return;
    const job = queue.shift();
    if (job === undefined) return;
    current = job;
    started().postMessage({ id: job.id, method: job.method, args: job.args });
  };
  const timedOut = (job: Job) => {
    const error = new HttpError(503, "timeout", `the query ran longer than ${Math.round(timeoutMs / 1000)} s`);
    if (current === job) {
      current = undefined;
      void end(worker); // stops the computation; the next request starts a new worker
    } else {
      const at = queue.indexOf(job);
      if (at >= 0) queue.splice(at, 1);
    }
    fail(job, error);
    pump();
  };
  const run = ((method: OffloadMethod, ...args: unknown[]) => {
    if (closing) return Promise.reject(new HttpError(503, "stopping", "the engine is stopping"));
    const key = `${method}\0${JSON.stringify(args)}`;
    const same = jobs.get(key);
    if (same !== undefined) return same.promise;
    if (jobs.size >= maxPending) {
      return Promise.reject(new HttpError(503, "busy", "too many slow queries wait; try again"));
    }
    let resolve!: (value: unknown) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<unknown>((y, n) => {
      resolve = y;
      reject = n;
    });
    const job: Job = { id: next++, key, method, args, promise, resolve, reject };
    job.timer = setTimeout(() => timedOut(job), timeoutMs);
    jobs.set(key, job);
    queue.push(job);
    pump();
    return promise;
  }) as Offload;
  return {
    run,
    async close() {
      closing = true;
      const stopping = new HttpError(503, "stopping", "the engine is stopping");
      for (const job of [...(current === undefined ? [] : [current]), ...queue.splice(0)]) fail(job, stopping);
      current = undefined;
      await end(worker);
    },
  };
}
