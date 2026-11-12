import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { expect, test } from "vitest";
import { claudeCodeCodec } from "../../src/adapters/claude-code/index.ts";
import { createIngest } from "../../src/ingest/index.ts";
import { openStore } from "../../src/store/index.ts";
import { scenarios } from "../fixtures.ts";
import { copyScenario } from "../ingest/corpus.ts";
import { normal } from "./graph.ts";
import { onCleanup, tempDir } from "./temp.ts";

const other = process.versions.bun === undefined ? "bun" : "node";
const available = spawnSync(other, ["--version"]).status === 0;

test.skipIf(!available)(
  `a store written under ${other} reads back the same graphs as one written here`,
  { timeout: 60_000 },
  async () => {
    const root = tempDir("qx-root-");
    const logs = scenarios().map(({ name }) => copyScenario(root, name).main);
    const theirs = tempDir("qx-data-");
    const child = spawnSync(other, [join(import.meta.dirname, "write-fixtures.ts"), root, theirs], {
      encoding: "utf8",
    });
    expect(child.stderr.replace(/.*ExperimentalWarning.*\n|.*--trace-warnings.*\n/g, "")).toBe("");
    expect(child.status).toBe(0);
    const mine = await openStore({ dataDir: tempDir("qx-data-") });
    onCleanup(() => mine.close());
    await createIngest({ store: mine, root }).ingestAll();
    const read = await openStore({ dataDir: theirs });
    onCleanup(() => read.close());
    for (const main of logs) {
      const graph = (s: typeof mine) => normal(s.log(main, "claude-code", claudeCodeCodec).graph());
      expect(graph(read)).toEqual(graph(mine));
    }
  },
);
