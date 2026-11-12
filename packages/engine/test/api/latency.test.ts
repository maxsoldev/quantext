/**
 * The engine stays responsive: `/health` answers fast while ingest catches up on a large log, and while a heavy
 * route is computed. Measured over HTTP in the same process as the work, as the engine runs.
 */
import { join } from "node:path";
import { expect, test } from "vitest";
import { claudeCodeCodec } from "../../src/adapters/claude-code/index.ts";
import { createApi } from "../../src/api/index.ts";
import { createQueryWorker } from "../../src/cli/query-worker-pool.ts";
import { createIngest } from "../../src/ingest/index.ts";
import { createQuery, installViews } from "../../src/query/index.ts";
import { openReader, openStore } from "../../src/store/index.ts";
import { syntheticSession } from "../adapters/claude-code/synthetic.ts";
import { writeText } from "../ingest/corpus.ts";
import { onCleanup, tempDir } from "../store/temp.ts";
import { get, viewerDir } from "./client.ts";

const CALLS = 2000;

/** Poll `/health` until `done` settles; the latencies in ms. */
async function poll(port: number, done: Promise<unknown>): Promise<number[]> {
  let finished = false;
  void done.finally(() => {
    finished = true;
  });
  const times: number[] = [];
  while (!finished) {
    const start = performance.now();
    await get(port, "/health");
    times.push(performance.now() - start);
    await new Promise((r) => setTimeout(r, 5));
  }
  return times;
}

const p95 = (times: number[]) => [...times].sort((a, b) => a - b)[Math.floor(times.length * 0.95)] ?? 0;

test(`/health answers in under 200 ms (p95) while a ${CALLS}-call log is ingested`, { timeout: 60_000 }, async () => {
  const root = tempDir("qx-root-");
  const dataDir = tempDir("qx-data-");
  writeText(
    join(root, "projects", "-synthetic", "00000000-0000-4000-8000-00000000beef.jsonl"),
    syntheticSession(CALLS),
  );
  const store = await openStore({ dataDir });
  onCleanup(() => store.close());
  const db = await openReader(dataDir, { setup: installViews });
  onCleanup(() => db.close());
  const query = createQuery({ db, codec: claudeCodeCodec });
  const info = { version: "0.0.0-test", pid: process.pid, startedAt: "", demo: false };
  const api = createApi({ query, info, staticDir: viewerDir() });
  const port = await api.listen(0);
  onCleanup(() => api.close());
  const ingest = createIngest({ store, root });
  const catchUp = ingest.ingestAll();
  const times = await poll(port, catchUp);
  console.log(
    `/health during catch-up: ${times.length} requests, p95 ${p95(times).toFixed(0)} ms, max ${Math.max(...times).toFixed(0)} ms`,
  );
  expect((await catchUp).callsAdded).toBe(CALLS);
  expect(times.length).toBeGreaterThan(5);
  expect(p95(times)).toBeLessThan(200);
});

test(`/health answers in under 200 ms (p95) while a ${CALLS}-call Session's lifetimes are computed`, {
  timeout: 60_000,
}, async () => {
  const root = tempDir("qx-root-");
  const dataDir = tempDir("qx-data-");
  writeText(
    join(root, "projects", "-synthetic", "00000000-0000-4000-8000-00000000beef.jsonl"),
    syntheticSession(CALLS),
  );
  const store = await openStore({ dataDir });
  await createIngest({ store, root }).ingestAll();
  store.close();
  const db = await openReader(dataDir, { setup: installViews });
  onCleanup(() => db.close());
  const query = createQuery({ db, codec: claudeCodeCodec });
  const worker = createQueryWorker({ dataDir });
  onCleanup(() => worker.close());
  const info = { version: "0.0.0-test", pid: process.pid, startedAt: "", demo: false };
  const api = createApi({ query, info, staticDir: viewerDir(), offload: worker.run });
  const port = await api.listen(0);
  onCleanup(() => api.close());
  const key = query.listSessions().items[0] ?? { log: 0, id: "" };
  const base = `/api/v1/sessions/${key.log}/${key.id}`;
  const heavy = Promise.all([get(port, `${base}/blocks?limit=5`), get(port, `${base}/tool-outputs?limit=5`)]);
  const times = await poll(port, heavy);
  const [blocks, outputs] = await heavy;
  console.log(
    `/health during lifetimes: ${times.length} requests, p95 ${p95(times).toFixed(0)} ms, max ${Math.max(...times).toFixed(0)} ms`,
  );
  expect(blocks.json()).toEqual(JSON.parse(JSON.stringify(query.blockLifetimes(key, { limit: 5 }))));
  expect(outputs.json()).toEqual(JSON.parse(JSON.stringify(query.toolOutputs(key, { limit: 5 }))));
  expect(times.length).toBeGreaterThan(5);
  expect(p95(times)).toBeLessThan(200);
});
