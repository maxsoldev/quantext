/**
 * Performance guard for the query layer on a synthetic 2000-call session. Measured on the development machine at
 * about a tenth of the limits; the limits are generous so that slower CI runners pass. Numbers are printed.
 */
import { join } from "node:path";
import { expect, test } from "vitest";
import { claudeCodeCodec } from "../../src/adapters/claude-code/index.ts";
import { createIngest } from "../../src/ingest/index.ts";
import { createQuery, installViews, runSql } from "../../src/query/index.ts";
import { openReader, openStore } from "../../src/store/index.ts";
import { syntheticSession } from "../adapters/claude-code/synthetic.ts";
import { writeText } from "../ingest/corpus.ts";
import { onCleanup, tempDir } from "../store/temp.ts";

const CALLS = 2000;

function timed<T>(work: () => T): { ms: number; result: T } {
  const start = performance.now();
  const result = work();
  return { ms: performance.now() - start, result };
}

test(`on a ${CALLS}-call session: the context of its last Call, the session list and the lifetime view`, {
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
  const q = createQuery({ db, codec: claudeCodeCodec });
  const list = timed(() => q.listSessions());
  const key = list.result.items[0] ?? { log: 0, id: "" };
  const last = q.listCalls(key).at(-1)?.index ?? -1;
  const context = timed(() => q.contextAt(key, last));
  const diff = timed(() => q.contextDiff(key, last));
  const lifetime = timed(() =>
    runSql(
      db,
      "SELECT block_hash, lifetime_cost_usd FROM v_block_lifetime_cost ORDER BY lifetime_cost_usd DESC LIMIT 10",
    ),
  );
  console.log(
    `${CALLS}-call session, ${context.result?.blocks.length} entries at its last Call: listSessions ${list.ms.toFixed(0)} ms,` +
      ` contextAt ${context.ms.toFixed(0)} ms, contextDiff ${diff.ms.toFixed(0)} ms, lifetime top 10 ${lifetime.ms.toFixed(0)} ms`,
  );
  expect(context.result?.blocks.length).toBeGreaterThan(2 * CALLS);
  expect(lifetime.result.rows).toHaveLength(10);
  expect(list.ms).toBeLessThan(500);
  expect(context.ms).toBeLessThan(500);
  expect(diff.ms).toBeLessThan(1000);
  expect(lifetime.ms).toBeLessThan(10_000);
});
