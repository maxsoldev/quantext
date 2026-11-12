/** The SQL views give the same numbers as the query layer, which reads the store a different way. */
import { describe, expect, test } from "vitest";
import { claudeCodeCodec } from "../../src/adapters/claude-code/index.ts";
import { createQuery, runSql } from "../../src/query/index.ts";
import { ingested } from "./corpus.ts";

async function setup() {
  const { db } = await ingested();
  const q = createQuery({ db, codec: claudeCodeCodec });
  const sessions = q.listSessions().items.flatMap((m) => [m, ...(m.subagents ?? [])]);
  const rows = (sql: string) => runSql(db, sql, { limit: 100_000 }).rows;
  return { q, sessions, rows };
}

describe("the views against the query layer", () => {
  test("v_sessions has each Session's totals", async () => {
    const { sessions, rows } = await setup();
    const view = rows("SELECT * FROM v_sessions");
    expect(view).toHaveLength(sessions.length);
    for (const s of sessions) {
      const v = view.find((r) => r.log === s.log && r.id === s.id);
      expect(v).toMatchObject({
        calls: s.calls,
        input_tokens: s.tokens.input,
        cache_read_tokens: s.tokens.cacheRead,
        cache_write_tokens: s.tokens.cacheWrite,
        output_tokens: s.tokens.output,
        max_context_tokens: s.maxContextTokens,
      });
      expect(v?.cost_total_usd).toBeCloseTo(s.cost.totalUsd, 12);
    }
  });

  test("v_calls and v_context give each Call's usage and the tokens of its Blocks", async () => {
    const { q, sessions, rows } = await setup();
    for (const s of sessions) {
      for (const call of q.listCalls(s)) {
        const [v] = rows(
          `SELECT * FROM v_calls WHERE log = ${s.log} AND session_id = '${s.id}' AND idx = ${call.index}`,
        );
        expect(v).toMatchObject({
          id: call.id,
          lane: call.lane,
          cache_read_tokens: call.usage?.cacheReadTokens ?? null,
        });
        const ctx = q.contextAt(s, call.index);
        const [sum] = rows(
          `SELECT count(*) AS n, coalesce(sum(tokens), 0) AS tokens FROM v_context WHERE log = ${s.log}
           AND session_id = '${s.id}' AND lane = '${call.lane}' AND first_call <= ${call.index} AND last_call >= ${call.index}`,
        );
        const blocks = (ctx?.blocks ?? []).filter((b) => b.hash !== undefined);
        expect(sum).toEqual({ n: blocks.length, tokens: blocks.reduce((n, b) => n + (b.tokens ?? 0), 0) });
      }
    }
  });

  test("v_block_lifetime_cost sums each Block's tokens and cost share over every Call it was sent in", async () => {
    const { q, sessions, rows } = await setup();
    const expected = new Map<string, { calls: number; tokens: number; read: number; usd: number }>();
    for (const s of sessions) {
      for (const call of q.listCalls(s)) {
        for (const b of q.contextAt(s, call.index)?.blocks ?? []) {
          if (b.hash === undefined) continue;
          const k = `${s.log}:${b.hash}`;
          const e = expected.get(k) ?? { calls: 0, tokens: 0, read: 0, usd: 0 };
          e.calls++;
          e.tokens += call.usage === undefined ? 0 : (b.tokens ?? 0);
          e.read += b.inCachedPrefix && call.usage !== undefined ? (b.tokens ?? 0) : 0;
          e.usd += b.costUsd ?? 0;
          expected.set(k, e);
        }
      }
    }
    const view = rows("SELECT * FROM v_block_lifetime_cost");
    expect(view).toHaveLength(expected.size);
    for (const v of view) {
      const e = expected.get(`${v.log}:${v.block_hash}`);
      expect(v.calls).toBe(e?.calls);
      expect(v.lifetime_tokens).toBe(e?.tokens);
      expect(Number(v.cache_read_tokens) + Number(v.cache_write_tokens) + Number(v.input_tokens)).toBe(e?.tokens);
      // The Block at the cache boundary adds its read part on top of the wholly cached ones.
      expect(Number(v.cache_read_tokens)).toBeGreaterThanOrEqual(e?.read ?? 0);
      expect(Number(v.lifetime_cost_usd)).toBeCloseTo(e?.usd ?? 0, 9);
    }
  });

  test("v_tool_outputs has each tool result with its tool, input, tokens and the Calls it stayed in", async () => {
    const { q, sessions, rows } = await setup();
    const tools = sessions.flatMap((s) => q.toolCalls(s).map((t) => ({ s, t })));
    const view = rows("SELECT * FROM v_tool_outputs");
    expect(view).toHaveLength(tools.length);
    for (const { s, t } of tools) {
      const v = view.find((r) => r.log === s.log && r.tool_use_id === t.id);
      expect(v).toMatchObject({
        tool: t.name,
        session_id: s.id,
        tokens: t.resultTokens ?? null,
        call_idx: t.callIndex,
      });
      expect(v?.input_summary).toBe(JSON.stringify(t.input).slice(0, 200));
      if (t.resultBlockHash === undefined) continue;
      const inCalls = q
        .listCalls(s)
        .filter((c) => q.contextAt(s, c.index)?.blocks.some((b) => b.hash === t.resultBlockHash))
        .map((c) => c.index);
      expect(v).toMatchObject({ calls: inCalls.length, first_call: inCalls[0], last_call: inCalls.at(-1) });
    }
  });

  test("v_cache_breaks has each Call whose cache read dropped against the previous Call of its lane", async () => {
    const { q, sessions, rows } = await setup();
    const expected = sessions.flatMap((s) => {
      const calls = q.listCalls(s).filter((c) => c.usage !== undefined);
      return calls.flatMap((c) => {
        const prev = calls.filter((p) => p.lane === c.lane && p.index < c.index).at(-1);
        const drop = (prev?.usage?.cacheReadTokens ?? 0) - (c.usage?.cacheReadTokens ?? 0);
        return prev !== undefined && drop > 0
          ? [
              {
                session_id: s.id,
                idx: c.index,
                prev_idx: prev.index,
                drop_tokens: drop,
                break_position: c.cacheBoundary?.position ?? null,
              },
            ]
          : [];
      });
    });
    expect(rows("SELECT session_id, idx, prev_idx, drop_tokens, break_position FROM v_cache_breaks")).toEqual(expected);
    expect(expected.length).toBeGreaterThan(0);
  });
});
