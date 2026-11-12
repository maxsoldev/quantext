import { describe, expect, test } from "vitest";
import { parseClaudeCodeSession } from "../../../src/adapters/claude-code/index.ts";
import { mainRows, scenarios, transcriptsOf } from "../../fixtures.ts";

describe.each(scenarios())("cost of $version/$name", ({ name }) => {
  const graph = parseClaudeCodeSession(transcriptsOf(name));

  test("the cost of all Calls is the harness's own running total", () => {
    const costStates = mainRows(name).filter((row) => row.type === "cost-state");
    const harnessTotal = costStates.at(-1)?.totalCostUSD as number;
    const ours = graph.calls.reduce((sum, call) => sum + (call.cost?.totalUsd ?? Number.NaN), 0);
    expect(ours).toBeCloseTo(harnessTotal, 9);
  });

  test.each(graph.calls.map((call) => [call.index, call] as const))(
    "call %i: its parts add up to its cost",
    (_, call) => {
      const cost = call.cost;
      expect(cost?.totalUsd).toBeCloseTo(
        (cost?.inputUsd ?? 0) + (cost?.cacheReadUsd ?? 0) + (cost?.cacheWriteUsd ?? 0) + (cost?.outputUsd ?? 0),
        12,
      );
    },
  );

  test.each(graph.calls.filter((c) => c.usage?.basis === "exact").map((call) => [call.index, call] as const))(
    "call %i: its blocks' cost shares and its framing add up to its input cost",
    (_, call) => {
      const cost = call.cost;
      const shares = graph.callBlocks
        .filter((cb) => cb.callId === call.id)
        .reduce((sum, cb) => sum + (cb.costUsd ?? 0), 0);
      const framing = (call.framingTokens * (cost?.inputUsd ?? 0)) / (call.usage?.inputTokens || 1);
      expect(shares + framing).toBeCloseTo(
        (cost?.inputUsd ?? 0) + (cost?.cacheReadUsd ?? 0) + (cost?.cacheWriteUsd ?? 0),
        12,
      );
    },
  );
});

test("a Call on a model with no list price has no cost, and is flagged", () => {
  const { main } = transcriptsOf("image");
  const graph = parseClaudeCodeSession({
    main: main.replaceAll('"model":"eu.anthropic.claude-opus-5-5"', '"model":"eu.anthropic.claude-mystery-1"'),
    subagents: [],
  });
  expect(graph.calls[0]?.cost).toBeUndefined();
  expect(graph.calls[0]?.issues).toEqual([
    { kind: "no-price", detail: "no list price for model eu.anthropic.claude-mystery-1" },
  ]);
});
