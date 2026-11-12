/** Ingest every fixture into a store, for the cross-runtime test: `<runtime> write-fixtures.ts <root> <dataDir>`. */
import { createIngest } from "../../src/ingest/index.ts";
import { openStore } from "../../src/store/index.ts";

const [root, dataDir] = process.argv.slice(2);
if (root === undefined || dataDir === undefined) throw new Error("usage: write-fixtures.ts <root> <dataDir>");
const store = await openStore({ dataDir });
const summary = await createIngest({ store, root }).ingestAll();
store.close();
if (summary.errors.length > 0) throw new Error(JSON.stringify(summary.errors));
