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
  // Schema reads through pragmas are allowed; other pragmas (here: the database's file paths) are not.
  expect(reader.prepare("SELECT name FROM pragma_table_info('calls')").all().length).toBeGreaterThan(0);
  const setting = () => reader.prepare("SELECT * FROM pragma_database_list").all();
  if (await readsOnlyEnforced()) expect(setting).toThrow(/not authorized/i);
});
