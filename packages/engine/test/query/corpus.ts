/** A store ingested from every fixture scenario, opened read-only with the query layer's views. */

import { createIngest } from "../../src/ingest/index.ts";
import { installViews } from "../../src/query/index.ts";
import type { SqlDriver } from "../../src/store/index.ts";
import { openReader, openStore } from "../../src/store/index.ts";
import { scenarios } from "../fixtures.ts";
import { copyScenario } from "../ingest/corpus.ts";
import { onCleanup, tempDir } from "../store/temp.ts";

export interface Ingested {
  root: string;
  dataDir: string;
  /** A read-only connection with the views. */
  db: SqlDriver;
}

/** Ingest the fixtures (or the scenarios named) into a new data folder, and open it read-only. */
export async function ingested(
  names = scenarios().map((s) => s.name),
  prepare?: (root: string) => void,
): Promise<Ingested> {
  const root = tempDir("qx-root-");
  const dataDir = tempDir("qx-data-");
  for (const name of names) copyScenario(root, name);
  prepare?.(root);
  const store = await openStore({ dataDir });
  const summary = await createIngest({ store, root }).ingestAll();
  store.close();
  if (summary.errors.length > 0) throw new Error(`ingest failed: ${JSON.stringify(summary.errors)}`);
  const db = await openReader(dataDir, { setup: installViews });
  onCleanup(() => db.close());
  return { root, dataDir, db };
}
