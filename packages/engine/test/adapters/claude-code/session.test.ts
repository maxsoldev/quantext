import { describe, expect, test } from "vitest";
import { parseClaudeCodeSession } from "../../../src/adapters/claude-code/index.ts";
import { transcriptsOf } from "../../fixtures.ts";

describe("parseClaudeCodeSession on basic-tools", () => {
  const graph = parseClaudeCodeSession(transcriptsOf("basic-tools"));

  test("finds the one Session with its harness version and cwd", () => {
    expect(graph.sessions).toEqual([
      {
        id: "00000000-0000-4000-8000-000000000001",
        harness: "claude-code",
        harnessVersion: "2.1.322",
        project: "/fixture-0000000000000000/repo",
        cwd: "/fixture-0000000000000000/repo",
        started: "2026-11-12T00:26:03.286Z",
        ended: "2026-11-12T00:26:21.003Z",
      },
    ]);
  });

  test("finds one Call per logged request, in order", () => {
    expect(graph.calls.map((c) => c.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(graph.calls[0]).toMatchObject({
      id: "e84d663e-a0b2-43ff-b665-aa4dd26c8ee3",
      sessionId: "00000000-0000-4000-8000-000000000001",
      ts: "2026-11-12T00:26:03.334Z",
      model: "eu.anthropic.claude-opus-5-5",
      canonicalModel: "claude-opus-5-5",
      shapeHash: "8ce3e4cf9761e97b443f72a9368b9f57abbea4d178f9ffb247ebe351b6a9de20",
      params: { maxTokens: 128000, thinking: { type: "adaptive" }, effort: "medium" },
    });
  });

  test("takes exact Usage from the response, with the cache write split by time to live", () => {
    expect(graph.calls[0]?.usage).toEqual({
      basis: "exact",
      inputTokens: 2,
      cacheReadTokens: 0,
      cacheWriteTokens: 16557,
      cacheWrite5mTokens: 16557,
      cacheWrite1hTokens: 0,
      outputTokens: 86,
    });
  });

  test("counts the Usage of a response written over several rows once", () => {
    // Call 5's response is three rows (thinking, text, tool use) that each repeat the same usage.
    expect(graph.calls[5]?.usage).toMatchObject({ inputTokens: 2, cacheReadTokens: 26894, outputTokens: 200 });
  });

  test("prices each Call by part at the canonical model's list price", () => {
    // Opus 5.5: $4 input, $5 5-minute cache write, $0.20 cache read, $20 output per million tokens.
    expect(graph.calls[0]?.cost).toMatchObject({
      inputUsd: 0.000008,
      cacheReadUsd: 0,
      cacheWriteUsd: 0.082785,
      outputUsd: 0.00172,
      price: { model: "claude-opus-5-5" },
    });
    expect(graph.calls[0]?.cost?.totalUsd).toBeCloseTo(0.084513, 12);
  });

  test("reports no unknown records for a known transcript", () => {
    expect(graph.report).toEqual({ unknownRecords: {}, unreadable: [] });
  });
});

describe("parseClaudeCodeSession on input it does not know", () => {
  const known = transcriptsOf("basic-tools").main;

  test("counts unknown row types and unreadable lines, and still reads the rest", () => {
    const extra = ['{"type":"brand-new-row","sessionId":"x"}', "{not json", '{"type":"brand-new-row"}'].join("\n");
    const graph = parseClaudeCodeSession({ main: `${known}${extra}\n`, subagents: [] });
    expect(graph.calls).toHaveLength(8);
    expect(graph.report.unknownRecords).toEqual({ "brand-new-row": 2 });
    expect(graph.report.unreadable).toEqual([{ at: "main:64", reason: expect.stringContaining("not JSON") }]);
  });
});

describe("parameters per Call", () => {
  const graph = parseClaudeCodeSession(transcriptsOf("effort"));

  test("keep the effort and the thinking mode of each Call, also when the model changes", () => {
    expect(graph.calls.map((c) => [c.canonicalModel, c.params.effort, c.params.thinking, c.params.maxTokens])).toEqual([
      ["claude-opus-5-5", "high", { type: "adaptive" }, 128000],
      ["claude-opus-5-5", "low", { type: "adaptive" }, 128000],
      ["claude-sonnet-4-5", undefined, { type: "enabled", budgetTokens: 31999 }, 32000],
    ]);
  });

  test("price a Bedrock Sonnet id at the Sonnet list price", () => {
    // Sonnet 4.5: 10 input, 12 944 cache write (5 minutes) and 323 output tokens.
    expect(graph.calls[2]?.cost?.totalUsd).toBeCloseTo((10 * 3 + 12944 * 3.75 + 323 * 15) / 1e6, 12);
  });
});
