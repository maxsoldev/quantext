/** The estimate of the progress summaries that Claude Code bills but writes to no transcript (`unlogged.ts`). */
import { describe, expect, test } from "vitest";
import type { SubagentTrace } from "../../src/query/unlogged.ts";
import { estimateUnlogged } from "../../src/query/unlogged.ts";

const S = 1000;
const RATES = { input: 4e-6, cacheRead: 0.2e-6, output: 20e-6 };
/** One summary's cost besides its cache read: 400 input and 40 output tokens. */
const FIXED = 400 * RATES.input + 40 * RATES.output;

function trace(over: Partial<SubagentTrace>): SubagentTrace {
  return { started: 0, ended: 95 * S, calls: [], rows: [], rates: RATES, ...over };
}

describe("estimateUnlogged", () => {
  test("is zero with no subagents", () => {
    expect(estimateUnlogged([])).toEqual({ calls: 0, cacheReadTokens: 0, costUsd: 0, unpricedCalls: 0, subagents: 0 });
  });

  test("counts one summary per 30 s tick with new rows, reading the last prompt from the cache", () => {
    const calls = [
      { ts: 10 * S, promptTokens: 1000 },
      { ts: 40 * S, promptTokens: 2000 },
      { ts: 70 * S, promptTokens: 3000 },
    ];
    const e = estimateUnlogged([trace({ calls })]);
    expect(e.calls).toBe(3);
    expect(e.cacheReadTokens).toBe(6000);
    expect(e.costUsd).toBeCloseTo(6000 * RATES.cacheRead + 3 * FIXED, 12);
    expect(e.subagents).toBe(1);
  });

  test("skips a tick when the transcript did not change, and a tool result counts as a change", () => {
    const calls = [
      { ts: 10 * S, promptTokens: 1000 },
      { ts: 100 * S, promptTokens: 5000 },
    ];
    expect(estimateUnlogged([trace({ calls, ended: 100 * S })]).calls).toBe(1);
    const withResult = estimateUnlogged([trace({ calls, ended: 100 * S, rows: [50 * S] })]);
    expect(withResult.calls).toBe(2);
    expect(withResult.cacheReadTokens).toBe(2000);
  });

  test("has no tick for a run shorter than 30 s, or before the first Call ends", () => {
    expect(estimateUnlogged([trace({ ended: 29 * S, calls: [{ ts: 5 * S, promptTokens: 9 }] })]).calls).toBe(0);
    expect(estimateUnlogged([trace({ rows: [5 * S], calls: [{ ts: 50 * S, promptTokens: 9 }] })]).calls).toBe(1);
  });

  test("counts summaries of an unpriced subagent but adds no cost for them", () => {
    const calls = [{ ts: 10 * S, promptTokens: 1000 }];
    const { rates: _, ...unpriced } = trace({ calls });
    const e = estimateUnlogged([unpriced, trace({ calls })]);
    expect(e).toMatchObject({ calls: 2, unpricedCalls: 1, cacheReadTokens: 2000, subagents: 2 });
    expect(e.costUsd).toBeCloseTo(1000 * RATES.cacheRead + FIXED, 12);
  });

  test("sorts rows that come out of order, and has no tick after the run ended", () => {
    const calls = [
      { ts: 70 * S, promptTokens: 3000 },
      { ts: 10 * S, promptTokens: 1000 },
    ];
    const e = estimateUnlogged([trace({ calls, ended: 75 * S })]);
    expect(e.calls).toBe(1);
    expect(e.cacheReadTokens).toBe(1000);
  });
});
