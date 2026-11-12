/**
 * An estimate of Claude Code's subagent progress summaries, which it bills but writes to no transcript. While a
 * subagent runs, a timer fires every 30 s; when the subagent's transcript changed since the last tick, the harness
 * sends the subagent's whole context again (a cache read) with a short summary prompt and answer.
 */
import type { UnloggedEstimate } from "@quantext/shared";
import type { SqlRow } from "../store/index.ts";

/** The timer of the summaries, and the size of the prompt and the answer they add (ms, tokens). */
export const TICK_MS = 30_000;
export const SUMMARY_INPUT_TOKENS = 400;
export const SUMMARY_OUTPUT_TOKENS = 40;

/** One subagent's run, with times in ms since the epoch. */
export interface SubagentTrace {
  started: number;
  ended: number;
  /** Each Call when it was sent, with its prompt (input, cache read and cache write tokens). */
  calls: { ts: number; promptTokens: number }[];
  /** The times of its other transcript rows (tool results). */
  rows: number[];
  /** USD per token, from its own priced Calls; absent when it has none. */
  rates?: { input: number; cacheRead: number; output: number };
}

/**
 * The summaries of all `traces`: one per tick in the run that has a new row since the previous tick, reading the
 * prompt of the latest Call sent from the cache. The real timer waits 30 s after a summary ends, so this is a little high.
 */
export function estimateUnlogged(traces: readonly SubagentTrace[]): UnloggedEstimate {
  const out: UnloggedEstimate = { calls: 0, cacheReadTokens: 0, costUsd: 0, unpricedCalls: 0, subagents: 0 };
  for (const t of traces) {
    const calls = [...t.calls].sort((a, b) => a.ts - b.ts);
    const changes = [...t.rows, ...calls.map((c) => c.ts)].sort((a, b) => a - b);
    let n = 0;
    let c = -1; // the latest Call sent by this tick
    let r = 0; // the first change after the previous tick
    for (let tick = t.started + TICK_MS; tick <= t.ended; tick += TICK_MS) {
      while (c + 1 < calls.length && (calls[c + 1]?.ts ?? 0) <= tick) c++;
      let changed = false;
      while (r < changes.length && (changes[r] ?? 0) <= tick) {
        changed = true;
        r++;
      }
      const prompt = calls[c]?.promptTokens;
      if (!changed || prompt === undefined) continue;
      n++;
      out.cacheReadTokens += prompt;
      if (t.rates === undefined) out.unpricedCalls++;
      else {
        const { input, cacheRead, output } = t.rates;
        out.costUsd += prompt * cacheRead + SUMMARY_INPUT_TOKENS * input + SUMMARY_OUTPUT_TOKENS * output;
      }
    }
    out.calls += n;
    if (n > 0) out.subagents++;
  }
  return out;
}

/** The descendants of Session `(log, id)` (bound as log, id, log, id) and their Calls with usage, in order. */
export const UNLOGGED_SQL = `WITH RECURSIVE tree(id) AS (
  SELECT ?2 UNION SELECT s.id FROM tree t JOIN sessions s ON s.log = ?1 AND s.parent_id = t.id
),
tools AS (
  SELECT k.call_id, max(k.duration_ms) AS tool_ms FROM tree t JOIN tool_calls k ON k.log = ?1 AND k.session_id = t.id
  WHERE t.id <> ?2 GROUP BY k.call_id
)
SELECT s.id AS session_id, s.started, s.ended, c.ts, c.input_tokens, c.cache_read_tokens, c.cache_write_tokens,
  c.output_tokens, c.cost_input_usd, c.cost_cache_read_usd, c.cost_output_usd, c.cost_total_usd, tools.tool_ms
FROM tree t JOIN sessions s ON s.log = ?1 AND s.id = t.id
LEFT JOIN calls c ON c.log = s.log AND c.session_id = s.id AND c.input_tokens IS NOT NULL
LEFT JOIN tools ON tools.call_id = c.id
WHERE t.id <> ?2 ORDER BY s.id, c.idx`;

/**
 * The traces of `UNLOGGED_SQL`'s rows. Besides each request, a run changes when it ends and when a response is
 * written: just before the next request, by the longest tool use of that response. Rates are the subagent's own
 * cost per token; with no priced cache read it has none.
 */
export function tracesOf(rows: readonly SqlRow[]): SubagentTrace[] {
  const bySession = new Map<string, SqlRow[]>();
  for (const r of rows) {
    const list = bySession.get(String(r.session_id)) ?? [];
    list.push(r);
    bySession.set(String(r.session_id), list);
  }
  const traces: SubagentTrace[] = [];
  for (const list of bySession.values()) {
    const first = list[0];
    const started = Date.parse(String(first?.started));
    const ended = Date.parse(String(first?.ended));
    if (Number.isNaN(started) || Number.isNaN(ended)) continue;
    const sent = list.filter((r) => r.ts !== null && r.ts !== undefined);
    const calls = sent.map((r) => ({
      ts: Date.parse(String(r.ts)),
      promptTokens: Number(r.input_tokens) + Number(r.cache_read_tokens) + Number(r.cache_write_tokens),
    }));
    const rows = [ended];
    sent.forEach((r, i) => {
      const next = calls[i + 1];
      if (next !== undefined && r.tool_ms !== null) rows.push(next.ts - Number(r.tool_ms));
    });
    const trace: SubagentTrace = { started, ended, calls, rows };
    const priced = sent.filter((r) => r.cost_total_usd !== null);
    const sum = (k: string) => priced.reduce((n, r) => n + Number(r[k] ?? 0), 0);
    const per = (usd: string, tokens: string) => (sum(tokens) > 0 ? sum(usd) / sum(tokens) : 0);
    if (sum("cache_read_tokens") > 0) {
      trace.rates = {
        input: per("cost_input_usd", "input_tokens"),
        cacheRead: per("cost_cache_read_usd", "cache_read_tokens"),
        output: per("cost_output_usd", "output_tokens"),
      };
    }
    traces.push(trace);
  }
  return traces;
}
