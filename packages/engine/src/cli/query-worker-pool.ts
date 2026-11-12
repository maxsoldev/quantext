/**
 * The engine's side of the query worker (`query-worker.ts`): one worker thread, started on first use, that runs
 * the slow query methods; requests queue in it. A worker that dies fails its requests and is started again.
 */
import { Worker } from "node:worker_threads";
import type { DemoOptions } from "@quantext/shared";
import type { Offload } from "../api/index.ts";

export const OFFLOAD_METHODS = ["blockLifetimes", "toolOutputs"] as const;
export type OffloadMethod = (typeof OFFLOAD_METHODS)[number];

export interface QueryWorkerOptions {
  dataDir: string;
  demo?: DemoOptions;
  home?: string;
  user?: string;
  host?: string;
}

/** `.ts` in the repo, `.js` in the bundle (`dist/query-worker.js`). */
const EXT = import.meta.url.endsWith(".ts") ? "ts" : "js";

export function createQueryWorker(options: QueryWorkerOptions): { run: Offload; close(): Promise<void> } {
  let worker: Worker | undefined;
  let next = 0;
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  const failAll = (error: Error) => {
    for (const p of pending.values()) p.reject(error);
    pending.clear();
  };
  const started = (): Worker => {
    if (worker !== undefined) return worker;
    const w = new Worker(new URL(`./query-worker.${EXT}`, import.meta.url), { workerData: options });
    w.on("message", (m: { id?: number; result?: unknown; error?: string }) => {
      if (m.id === undefined) return; // ready
      const p = pending.get(m.id);
      pending.delete(m.id);
      if (m.error !== undefined) p?.reject(new Error(m.error));
      else p?.resolve(m.result);
    });
    w.on("error", (error) => {
      worker = undefined;
      failAll(error);
    });
    w.on("exit", (code) => {
      if (worker === w) worker = undefined;
      failAll(new Error(`the query worker stopped (exit ${code})`));
    });
    w.unref();
    worker = w;
    return w;
  };
  const run = ((method: OffloadMethod, ...args: unknown[]) =>
    new Promise((resolve, reject) => {
      const id = next++;
      pending.set(id, { resolve, reject });
      started().postMessage({ id, method, args });
    })) as Offload;
  return {
    run,
    async close() {
      const w = worker;
      worker = undefined;
      if (w !== undefined) await w.terminate();
    },
  };
}
