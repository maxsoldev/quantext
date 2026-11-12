import { expect, test } from "vitest";
import { openReader, openStore, readsOnlyEnforced } from "../../src/store/index.ts";
import { onCleanup, tempDir } from "./temp.ts";

test("a reader for reads only lets SQLite deny everything but reads, where the runtime can", async () => {
  const dataDir = tempDir();
  (await openStore({ dataDir })).close();
  const reader = await openReader(dataDir, { readsOnly: true });
  onCleanup(() => reader.close());
  expect(
    reader
      .prepare("WITH RECURSIVE r(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM r WHERE i < 3) SELECT sum(i) AS s FROM r")
      .get(),
  ).toEqual({ s: 6 });
  const pragma = () => reader.prepare("SELECT name FROM pragma_table_info('calls')").all();
  if (await readsOnlyEnforced()) expect(pragma).toThrow(/not authorized/i);
  else expect(pragma().length).toBeGreaterThan(0);
});
