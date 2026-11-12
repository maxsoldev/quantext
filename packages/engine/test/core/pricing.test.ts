import { describe, expect, test } from "vitest";
import { canonicalModel, priceUsage } from "../../src/core/pricing.ts";

describe("canonicalModel", () => {
  test.each([
    ["claude-opus-5-5", "claude-opus-5-5"],
    ["eu.anthropic.claude-opus-5-5", "claude-opus-5-5"],
    ["anthropic.claude-opus-5-5", "claude-opus-5-5"],
    ["eu.anthropic.claude-sonnet-4-5-20250929-v1:0", "claude-sonnet-4-5"],
    ["eu.anthropic.claude-sonnet-4-5-20250929-v1:0[1m]", "claude-sonnet-4-5"],
    ["claude-sonnet-4-5-20250929", "claude-sonnet-4-5"],
    ["global.anthropic.claude-haiku-4-5-20251001-v1:0", "claude-haiku-4-5"],
    ["claude-opus-4-5@20251101", "claude-opus-4-5"],
    ["claude-opus-4-8[1m]", "claude-opus-4-8"],
  ])("maps %s to %s", (id, canonical) => {
    expect(canonicalModel(id)).toBe(canonical);
  });

  test("returns undefined for a model with no list price", () => {
    expect(canonicalModel("gpt-5")).toBeUndefined();
    expect(canonicalModel("claude-unknown-9")).toBeUndefined();
  });
});

describe("priceUsage", () => {
  const usage = {
    basis: "exact" as const,
    inputTokens: 1_000_000,
    cacheReadTokens: 1_000_000,
    cacheWriteTokens: 2_000_000,
    cacheWrite5mTokens: 1_000_000,
    cacheWrite1hTokens: 1_000_000,
    outputTokens: 1_000_000,
  };

  test("prices cache writes at 1.25x input for 5 minutes and 2x for 1 hour", () => {
    // Sonnet 4.5: $3 input, $15 output, $0.30 cache read.
    expect(priceUsage(usage, "claude-sonnet-4-5")).toMatchObject({
      inputUsd: 3,
      cacheReadUsd: 0.3,
      cacheWriteUsd: 3 * 1.25 + 3 * 2,
      outputUsd: 15,
      totalUsd: 3 + 0.3 + 9.75 + 15,
      price: { model: "claude-sonnet-4-5", date: "2026-11-03" },
    });
  });

  test("prices a cache write without a time-to-live split as 5 minutes", () => {
    const { cacheWrite5mTokens: _, cacheWrite1hTokens: __, ...plain } = usage;
    expect(priceUsage(plain, "claude-opus-5-5")?.cacheWriteUsd).toBe(2 * 4 * 1.25);
  });

  test("uses the model's own cache read price where it is not 0.1x", () => {
    expect(priceUsage(usage, "claude-opus-5-5")?.cacheReadUsd).toBe(0.2);
  });

  test("has no price for an unknown model", () => {
    expect(priceUsage(usage, "claude-unknown-9")).toBeUndefined();
  });
});
