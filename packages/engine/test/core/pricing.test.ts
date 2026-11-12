import { describe, expect, test } from "vitest";
import { blockCosts, canonicalModel, priceUsage } from "../../src/core/pricing.ts";

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

describe("blockCosts", () => {
  test("prices each block by the part of the input it is in: cache read, then cache write, then plain input", () => {
    const usage = {
      basis: "exact" as const,
      inputTokens: 2,
      cacheReadTokens: 100,
      cacheWriteTokens: 40,
      outputTokens: 0,
    };
    const cost = priceUsage(usage, "claude-opus-5-5");
    if (cost === undefined) throw new Error("no price");
    // Opus 5.5 per million: cache read $0.20, cache write (5 minutes) $5, input $4.
    const costs = blockCosts([50, 60, 30], usage, cost);
    expect(costs[0]).toBeCloseTo(50 * 0.2e-6, 15);
    expect(costs[1]).toBeCloseTo(50 * 0.2e-6 + 10 * 5e-6, 15);
    expect(costs[2]).toBeCloseTo(30 * 5e-6, 15);
  });

  test("leaves the framing after the last block at the plain input price", () => {
    const usage = {
      basis: "exact" as const,
      inputTokens: 2,
      cacheReadTokens: 100,
      cacheWriteTokens: 40,
      outputTokens: 7,
    };
    const cost = priceUsage(usage, "claude-opus-5-5");
    if (cost === undefined) throw new Error("no price");
    const total = blockCosts([50, 60, 30], usage, cost).reduce((a, b) => a + b, 0);
    expect(cost.inputUsd + cost.cacheReadUsd + cost.cacheWriteUsd - total).toBeCloseTo(2 * 4e-6, 15);
  });
});
