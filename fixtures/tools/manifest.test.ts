import { describe, expect, test } from "vitest";
import { compactionsOf, summariseTranscript } from "./manifest.ts";

describe("summariseTranscript", () => {
  test("counts rows by type and LLM calls (api-request rows), sorted by type", () => {
    const text = [
      '{"type":"user"}',
      '{"type":"api-request"}',
      '{"type":"assistant"}',
      '{"type":"api-request"}',
      '{"type":"assistant"}',
      "",
    ].join("\n");
    expect(summariseTranscript("s.jsonl", text)).toEqual({
      rows: 5,
      llmCalls: 2,
      rowTypes: { "api-request": 2, assistant: 2, user: 1 },
    });
  });

  test("counts a row without a type as `(none)`", () => {
    expect(summariseTranscript("s.jsonl", '{"a":1}\n').rowTypes).toEqual({ "(none)": 1 });
  });

  test("fails with the file and line on a row that is not JSON", () => {
    expect(() => summariseTranscript("s.jsonl", '{"type":"user"}\n{bad\n')).toThrow(/s\.jsonl:2/);
  });
});

describe("compactionsOf", () => {
  const usage = (input: number, output: number, read: number, write: number) => ({
    inputTokens: input,
    outputTokens: output,
    cacheReadInputTokens: read,
    cacheCreationInputTokens: write,
    costUSD: 0.1,
  });
  const assistant = (id: string) => ({
    type: "assistant",
    requestedModel: "m",
    message: {
      id,
      model: "m-short",
      usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 },
    },
  });

  test("derives the summary call's usage from the cost-state rows around the boundary, minus logged calls", () => {
    const text = [
      { type: "cost-state", modelUsage: { m: usage(6, 300, 100, 10) } },
      {
        type: "system",
        subtype: "compact_boundary",
        compactMetadata: { trigger: "manual", preTokens: 900, postTokens: 80 },
      },
      assistant("msg_1"),
      assistant("msg_1"), // one message over two rows: its usage counts once
      { type: "cost-state", modelUsage: { m: usage(2007, 812, 16613, 182) } },
    ]
      .map((row) => JSON.stringify(row))
      .join("\n");
    expect(compactionsOf(text)).toEqual([
      {
        line: 2,
        trigger: "manual",
        preTokens: 900,
        postTokens: 80,
        basis: "derived",
        summaryUsage: {
          m: { inputTokens: 2000, outputTokens: 510, cacheReadInputTokens: 16510, cacheCreationInputTokens: 168 },
        },
      },
    ]);
  });

  test("gives no summary usage when a cost-state row is missing", () => {
    const text = JSON.stringify({ type: "system", subtype: "compact_boundary", compactMetadata: { trigger: "auto" } });
    expect(compactionsOf(text)[0]?.summaryUsage).toBeNull();
  });
});
