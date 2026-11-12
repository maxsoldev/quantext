import { describe, expect, test } from "vitest";
import { claudeCodeCodec, createClaudeCodeParser } from "../../src/adapters/claude-code/index.ts";
import type { Store } from "../../src/store/index.ts";
import { openStore } from "../../src/store/index.ts";
import { scenarios, transcriptsOf } from "../fixtures.ts";
import { deltasOf } from "./graph.ts";
import { onCleanup, tempDir } from "./temp.ts";

async function open(): Promise<Store> {
  const store = await openStore({ dataDir: tempDir() });
  onCleanup(() => store.close());
  return store;
}

describe("the change cursor", () => {
  test("grows with each write that changes a Session, and names the Calls added with their index", async () => {
    const store = await open();
    expect(store.changeCursor()).toBe(0);
    const log = store.log("/logs/a.jsonl", "claude-code", claudeCodeCodec);
    const parser = createClaudeCodeParser();
    const lines = transcriptsOf("basic-tools").main.split("\n");
    const half = Math.floor(lines.length / 2);
    const first = log.write({ deltas: [parser.push(`${lines.slice(0, half).join("\n")}\n`)] });
    const second = log.write({ deltas: [parser.push(`${lines.slice(half).join("\n")}\n`)] });
    expect(first.cursor).toBe(1);
    expect(second.cursor).toBe(2);
    expect(store.changeCursor()).toBe(2);
    expect(log.write({ deltas: [], files: [] }).cursor).toBe(2); // nothing changed
    const added = [...first.calls, ...second.calls].flatMap((c) => c.addedIndexes);
    expect(added).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    const seq = store.db.prepare("SELECT changed_seq FROM sessions").all();
    expect(seq).toEqual([{ changed_seq: 2 }]);
  });
});

describe("the cache boundary offset of a Call", () => {
  test.each(scenarios().map((s) => s.name))(
    "is the tokens of the Blocks before its cache boundary (%s)",
    async (name) => {
      const store = await open();
      const log = store.log("/logs/a.jsonl", "claude-code", claudeCodeCodec);
      for (const delta of deltasOf(transcriptsOf(name))) log.write({ deltas: [delta] });
      const graph = log.graph();
      const rows = store.db
        .prepare("SELECT session_id, idx, cache_boundary_offset FROM calls WHERE cache_boundary_position IS NOT NULL")
        .all();
      expect(rows.length).toBeGreaterThan(0);
      for (const r of rows) {
        const call = graph.calls.find((c) => c.sessionId === r.session_id && c.index === r.idx);
        const before = graph.callBlocks
          .filter(
            (b) =>
              b.sessionId === call?.sessionId &&
              b.lane === call?.lane &&
              b.firstCall <= (call?.index ?? 0) &&
              (b.lastCall === undefined || b.lastCall >= (call?.index ?? 0)) &&
              b.position < (call?.cacheBoundary?.position ?? 0),
          )
          .reduce((n, b) => n + (b.tokens ?? 0), 0);
        expect(r.cache_boundary_offset).toBe(before);
      }
    },
  );
});
