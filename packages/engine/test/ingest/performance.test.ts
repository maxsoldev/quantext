/**
 * Performance guard for ingest. Measured on the development machine (Apple silicon) at about a tenth of the limits;
 * the limits are generous so that slower CI runners pass. The numbers are printed for the record.
 */
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { claudeCodeCodec } from "../../src/adapters/claude-code/index.ts";
import { createIngest } from "../../src/ingest/index.ts";
import { openStore } from "../../src/store/index.ts";
import { syntheticSession } from "../adapters/claude-code/synthetic.ts";
import { scenarios } from "../fixtures.ts";
import { onCleanup, tempDir } from "../store/temp.ts";
import { copyScenario, writeText } from "./corpus.ts";

const CALLS = 2000;

async function setup() {
  const root = tempDir("qx-root-");
  const store = await openStore({ dataDir: tempDir("qx-data-") });
  onCleanup(() => store.close());
  return { root, store, ingest: createIngest({ store, root }) };
}

async function timed<T>(work: () => Promise<T>): Promise<{ ms: number; result: T }> {
  const start = performance.now();
  const result = await work();
  return { ms: performance.now() - start, result };
}

test("every fixture ingests in under 3 s", async () => {
  const { root, ingest } = await setup();
  for (const { name } of scenarios()) copyScenario(root, name);
  const { ms, result } = await timed(() => ingest.ingestAll());
  console.log(`ingest of ${result.logs} fixture logs (${result.bytes} bytes): ${ms.toFixed(0)} ms`);
  expect(result.errors).toEqual([]);
  expect(ms).toBeLessThan(3000);
});

test(`a ${CALLS}-call session ingests in under 5 s, and one more call in under 1 s`, {
  timeout: 30_000,
}, async () => {
  const { root, store, ingest } = await setup();
  const text = syntheticSession(CALLS + 1);
  const lines = text.split("\n");
  // The last call's request and response, and the rows of the next call: the cut is after the 2000th call.
  const cut = lines.findIndex((l) => l.includes(`"id":"call-${CALLS}"`));
  const main = join(root, "projects", "-synthetic", "00000000-0000-4000-8000-00000000beef.jsonl");
  writeText(main, `${lines.slice(0, cut).join("\n")}\n`);
  const heap = process.memoryUsage().heapUsed;
  const whole = await timed(() => ingest.ingestAll());
  const mb = (process.memoryUsage().heapUsed - heap) / 1e6;
  appendFileSync(main, `${lines.slice(cut).join("\n")}`);
  const more = await timed(() => ingest.ingestAll());
  const graph = store.log(main, "claude-code", claudeCodeCodec).graph();
  console.log(
    `${CALLS}-call session (${whole.result.bytes} bytes): ${whole.ms.toFixed(0)} ms, heap +${mb.toFixed(0)} MB;` +
      ` one more call: ${more.ms.toFixed(0)} ms`,
  );
  expect(graph.calls).toHaveLength(CALLS + 1);
  expect(graph.calls.filter((c) => c.issues.length > 0)).toEqual([]);
  expect(more.result.callsAdded).toBe(1);
  expect(whole.ms).toBeLessThan(5000);
  expect(more.ms).toBeLessThan(1000);
});
