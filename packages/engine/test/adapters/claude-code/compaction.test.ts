import { describe, expect, test } from "vitest";
import { parseClaudeCodeSession } from "../../../src/adapters/claude-code/index.ts";
import { transcriptsOf } from "../../fixtures.ts";

const SESSION = "00000000-0000-4000-8000-000000000005";
const BOUNDARY = "7842f299-4e3b-4f1d-91d4-f2fdf998f534";

describe("a manual compaction", () => {
  const graph = parseClaudeCodeSession(transcriptsOf("compaction"));
  const summary = graph.calls.find((c) => c.id === graph.compactions[0]?.summaryCallId);

  test("is a Compaction with the context size before and after, as the harness reports it", () => {
    expect(graph.compactions).toEqual([
      {
        id: BOUNDARY,
        sessionId: SESSION,
        ts: "2026-11-12T00:26:57.332Z",
        trigger: "manual",
        beforeTokens: 16778,
        afterTokens: 2865,
        beforeCallId: graph.calls[2]?.id,
        summaryCallId: `${BOUNDARY}:summary`,
      },
    ]);
  });

  test("starts the layout of its lane again: the next Call keeps nothing from before the compaction", () => {
    const next = graph.calls[4];
    const runs = graph.callBlocks.filter(
      (r) =>
        r.lane === next?.lane && r.firstCall <= (next?.index ?? 0) && (r.lastCall ?? Infinity) >= (next?.index ?? 0),
    );
    expect(runs.length).toBeGreaterThan(0);
    expect(runs.every((r) => r.firstCall === next?.index)).toBe(true);
    expect(next?.issues).toEqual([]);
  });

  test("has a summarising Call in log order, with usage derived from the running totals", () => {
    expect(graph.calls.map((c) => c.usage?.basis)).toEqual(["exact", "exact", "exact", "derived", "exact"]);
    expect(summary).toMatchObject({
      index: 3,
      model: "eu.anthropic.claude-opus-5-5",
      canonicalModel: "claude-opus-5-5",
    });
    expect(summary?.usage).toEqual({
      basis: "derived",
      inputTokens: 2051,
      cacheReadTokens: 16510,
      cacheWriteTokens: 154,
      cacheWrite5mTokens: 154,
      cacheWrite1hTokens: 0,
      outputTokens: 569,
    });
  });

  test("prices the summarising Call as the harness's running cost changed, plus the regional 10%", () => {
    // cost-state totalCostUSD (list price) went from 0.0449442 to 0.0686002 over the compaction.
    expect(summary?.cost?.totalUsd).toBeCloseTo(1.1 * (0.0686002 - 0.0449442), 10);
  });

  test("flags that the summarising request is not in the log, and names the call whose context it summarised", () => {
    expect(summary?.issues).toEqual([
      { kind: "unresolved-request", detail: "the summarising request is not in the log, only its derived usage" },
    ]);
    expect(graph.compactions[0]?.beforeCallId).toBe(graph.calls[2]?.id);
    expect(graph.callBlocks.filter((r) => r.lane === summary?.lane)).toEqual([]);
  });

  test("flags a derived input smaller than the context before the compaction", () => {
    const { main } = transcriptsOf("compaction");
    const graph = parseClaudeCodeSession({
      main: main.replace('"preTokens":16778', '"preTokens":99999'),
      subagents: [],
    });
    const call = graph.calls.find((c) => c.usage?.basis === "derived");
    expect(call?.issues).toContainEqual({
      kind: "unreconciled-tokens",
      detail: "derived input 18715 is less than the 99999 tokens of context before the compaction",
    });
  });

  /** The compaction scenario with the input counters of the running total after it changed by `delta`. */
  const withInputChange = (delta: (before: number) => number) => {
    const lines = transcriptsOf("compaction").main.split("\n");
    const costs = lines.flatMap((l, i) => (l.includes('"type":"cost-state"') ? [i] : []));
    const [beforeAt, afterAt] = [costs[0] ?? 0, costs[1] ?? 0];
    const before = JSON.parse(lines[beforeAt] ?? "{}");
    const after = JSON.parse(lines[afterAt] ?? "{}");
    for (const [model, totals] of Object.entries(after.modelUsage as Record<string, Record<string, number>>)) {
      const old = before.modelUsage[model] as Record<string, number>;
      for (const key of ["inputTokens", "cacheReadInputTokens", "cacheCreationInputTokens"]) {
        totals[key] = delta(old[key] ?? 0);
      }
      totals.cacheCreationEphemeral5mInputTokens = totals.cacheCreationInputTokens ?? 0;
    }
    lines[afterAt] = JSON.stringify(after);
    const graph = parseClaudeCodeSession({ main: lines.join("\n"), subagents: [] });
    return graph.calls.find((c) => c.id === graph.compactions[0]?.summaryCallId);
  };

  test.each([
    ["zero", (b: number) => b],
    ["negative", (b: number) => Math.max(0, b - 500)],
  ])("gets no usage and no cost when its derived input is %s, and says why", (_, delta) => {
    const call = withInputChange(delta);
    expect(call?.usage).toBeUndefined();
    expect(call?.cost).toBeUndefined();
    expect(call?.issues.map((i) => i.kind)).toEqual(["derived-usage-invalid", "unresolved-request"]);
    expect(call?.issues[0]?.detail).toMatch(/^the running totals give an input of -?\d+ tokens/);
  });
});
