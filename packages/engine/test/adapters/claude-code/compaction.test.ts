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
        summaryCallId: `${BOUNDARY}:summary`,
      },
    ]);
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

  test("prices the summarising Call as the harness's running cost changed", () => {
    // cost-state totalCostUSD went from 0.0449442 to 0.0686002 over the compaction.
    expect(summary?.cost?.totalUsd).toBeCloseTo(0.0686002 - 0.0449442, 10);
  });

  test("flags that the summarising request is not in the log, and keeps the context it was sent", () => {
    expect(summary?.issues).toEqual([
      { kind: "unresolved-request", detail: "the summarising request is not in the log, only its derived usage" },
    ]);
    const before = graph.callBlocks.filter((cb) => cb.callId === graph.calls[2]?.id);
    const sent = graph.callBlocks.filter((cb) => cb.callId === summary?.id);
    expect(sent.slice(0, before.length).map((cb) => cb.blockHash)).toEqual(before.map((cb) => cb.blockHash));
    expect(sent).toHaveLength(before.length + 1); // and the last response, a text
    expect(sent.every((cb) => cb.tokens === undefined)).toBe(true);
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
});
