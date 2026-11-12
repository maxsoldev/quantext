/** Open a store and hold it until killed, for the lock tests: `<runtime> hold-store.ts <dataDir>`. */
import { openStore } from "../../src/store/index.ts";

const [dataDir] = process.argv.slice(2);
if (dataDir === undefined) throw new Error("usage: hold-store.ts <dataDir>");
await openStore({ dataDir });
process.stdout.write("ready\n");
setInterval(() => undefined, 60_000);
