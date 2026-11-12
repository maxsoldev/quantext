/**
 * The query layer's lifetimes (`lifetimes.ts`, near-linear) equal the SQL definition (`lifetimeSql`, which joins
 * every run with every Call it covers) on every fixture and on synthetic Sessions whose prices, boundaries and
 * tokens are scrambled at random, NULLs included.
 */
import { join } from "node:path";
import type { SessionKey } from "@quantext/shared";
import { describe, expect, test } from "vitest";
import { claudeCodeCodec } from "../../src/adapters/claude-code/index.ts";
import type { Query } from "../../src/query/index.ts";
import { createQuery } from "../../src/query/index.ts";
import { lifetimeSql, toolOutputsSql } from "../../src/query/views.ts";
import type { SqlDriver, SqlRow } from "../../src/store/index.ts";
import { syntheticSession } from "../adapters/claude-code/synthetic.ts";
import { scenarios } from "../fixtures.ts";
import { writeText } from "../ingest/corpus.ts";
import { random } from "../store/graph.ts";
import { ingested } from "./corpus.ts";

const COUNTS = [
  "runs",
  "calls",
  "tokens",
  "lifetime_tokens",
  "cache_read_tokens",
  "cache_write_tokens",
  "input_tokens",
];
const COSTS = ["cost_cache_read_usd", "cost_cache_write_usd", "cost_input_usd", "lifetime_cost_usd"];

/** Every Session's lifetimes by both ways; the counts equal, the costs to 1e-9 of their size. */
function compare(db: SqlDriver, q: Query): number {
  let checked = 0;
  const keys = db.prepare("SELECT log, id FROM sessions").all() as unknown as SessionKey[];
  for (const key of keys) {
    const sql = new Map(
      db
        .prepare(lifetimeSql(true))
        .all(key.log, key.id)
        .map((r) => [String(r.block_hash), r]),
    );
    const ours = q.blockLifetimes(key, { limit: 1_000_000 }).items;
    expect(new Set(ours.map((b) => b.hash))).toEqual(new Set(sql.keys()));
    for (const b of ours) {
      const r = sql.get(b.hash) as SqlRow;
      const got: Record<string, number | undefined> = {
        runs: b.runs,
        calls: b.calls,
        tokens: b.tokens,
        lifetime_tokens: b.lifetimeTokens,
        cache_read_tokens: b.tokensByPart.cacheRead,
        cache_write_tokens: b.tokensByPart.cacheWrite,
        input_tokens: b.tokensByPart.input,
        cost_cache_read_usd: b.costUsd.cacheRead,
        cost_cache_write_usd: b.costUsd.cacheWrite,
        cost_input_usd: b.costUsd.input,
        lifetime_cost_usd: b.costUsd.total,
      };
      for (const k of COUNTS) {
        const want = r[k] === null ? (k === "tokens" ? undefined : 0) : Number(r[k]);
        expect([b.hash, k, got[k]]).toEqual([b.hash, k, want]);
      }
      for (const k of COSTS) {
        const want = Number(r[k] ?? 0);
        expect(Math.abs((got[k] ?? 0) - want)).toBeLessThanOrEqual(1e-9 * Math.max(1, Math.abs(want)));
      }
      checked++;
    }
    const tools = new Map(
      db
        .prepare(toolOutputsSql(`(${lifetimeSql(true)})`, "WHERE t.log = ? AND t.session_id = ?", false))
        .all(key.log, key.id, key.log, key.id)
        .map((r) => [String(r.tool_use_id), r]),
    );
    const outputs = q.toolOutputs(key, { limit: 1_000_000 }).items;
    expect(new Set(outputs.map((o) => o.toolUseId))).toEqual(new Set(tools.keys()));
    for (const o of outputs) {
      const r = tools.get(o.toolUseId) as SqlRow;
      expect([o.toolUseId, o.calls, o.lifetimeTokens]).toEqual([
        o.toolUseId,
        Number(r.calls ?? 0),
        Number(r.lifetime_tokens ?? 0),
      ]);
      const want = Number(r.lifetime_cost_usd ?? 0);
      expect(Math.abs(o.costUsd.total - want)).toBeLessThanOrEqual(1e-9 * Math.max(1, Math.abs(want)));
      // The ToolCall's own Block (what the model wrote), as input to the Calls after it.
      const own = r.call_block_hash === null ? undefined : sql.get(String(r.call_block_hash));
      expect([o.toolUseId, o.toolCall?.blockHash]).toEqual([o.toolUseId, own?.block_hash ?? undefined]);
      if (own !== undefined && o.toolCall !== undefined) {
        expect([o.toolCall.calls, o.toolCall.lifetimeTokens]).toEqual([Number(own.calls), Number(own.lifetime_tokens)]);
        const cost = Number(own.lifetime_cost_usd ?? 0);
        expect(Math.abs(o.toolCall.costUsd.total - cost)).toBeLessThanOrEqual(1e-9 * Math.max(1, Math.abs(cost)));
      }
    }
  }
  return checked;
}

/** Scramble what pricing reads: boundaries, offsets, cache parts, prices and run tokens, some of them NULL. */
function scramble(seed: number) {
  return (db: SqlDriver) => {
    const next = random(seed);
    const pick = <T>(xs: T[]): T => xs[Math.floor(next() * xs.length)] as T;
    const calls = db.prepare("SELECT log, id FROM calls").all();
    const set = db.prepare(
      `UPDATE calls SET cache_boundary_position = ?, cache_boundary_offset = ?, cache_read_tokens = ?,
       cache_write_tokens = ?, unit_read_usd = ?, unit_rest_usd = ? WHERE log = ? AND id = ?`,
    );
    for (const c of calls) {
      set.run(
        pick([null, 0, 1, 2, 3, 5, 8, 40, 400]),
        pick([null, 0, 10, 100, 5000]),
        pick([null, 0, 50, 3000, 90_000]),
        pick([null, 0, 0, 20, 700]),
        pick([null, 3e-7, 1.5e-6]),
        pick([null, 3.75e-6, 1.5e-5, 6e-6]),
        c.log ?? null,
        c.id ?? null,
      );
    }
    const runs = db.prepare("SELECT log, session_id, lane, first_call, position FROM call_blocks").all();
    const tokens = db.prepare(
      "UPDATE call_blocks SET tokens = ? WHERE log = ? AND session_id = ? AND lane = ? AND first_call = ? AND position = ?",
    );
    for (const r of runs) {
      if (next() < 0.3)
        tokens.run(
          pick([null, 0, 7, 1234]),
          ...[r.log, r.session_id, r.lane, r.first_call, r.position].map((v) => v ?? null),
        );
    }
  };
}

const synthetic = (calls: number, sideEvery: number) => (root: string) =>
  writeText(
    join(root, "projects", "-synthetic", "00000000-0000-4000-8000-00000000beef.jsonl"),
    syntheticSession(calls, sideEvery),
  );

describe("lifetimes", () => {
  test("equal the SQL definition on every fixture", async () => {
    const { db } = await ingested(scenarios().map((s) => s.name));
    expect(compare(db, createQuery({ db, codec: claudeCodeCodec }))).toBeGreaterThan(100);
  });

  test("equal the SQL definition on synthetic Sessions with two lanes", async () => {
    const { db } = await ingested([], synthetic(300, 7));
    expect(compare(db, createQuery({ db, codec: claudeCodeCodec }))).toBeGreaterThan(300);
  });

  test("equal the SQL definition when prices, boundaries and tokens are scrambled, NULLs included", async () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const { db } = await ingested(["basic-tools", "compaction", "subagent"], synthetic(120, 5), scramble(seed));
      expect(compare(db, createQuery({ db, codec: claudeCodeCodec }))).toBeGreaterThan(100);
    }
  });
});
