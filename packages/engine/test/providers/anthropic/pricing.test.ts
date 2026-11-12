import type { Usage } from "@quantext/shared";
import { describe, expect, test } from "vitest";
import { blockCosts } from "../../../src/core/pricing.ts";
import { canonicalModel, PRICE_SOURCE, priceCall } from "../../../src/providers/anthropic/pricing.ts";

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
    ["claude-mythos-5-1", "claude-mythos-5-1"],
  ])("maps %s to %s", (id, canonical) => {
    expect(canonicalModel(id)).toBe(canonical);
  });

  test("returns undefined for a model with no list price", () => {
    expect(canonicalModel("gpt-5")).toBeUndefined();
    expect(canonicalModel("claude-unknown-9")).toBeUndefined();
  });
});

const M = 1_000_000;
const usage: Usage = {
  basis: "exact",
  inputTokens: M,
  cacheReadTokens: M,
  cacheWriteTokens: 2 * M,
  cacheWrite5mTokens: M,
  cacheWrite1hTokens: M,
  outputTokens: M,
};
const parts = (model: string, more: { speed?: string; inferenceGeo?: string } = {}, u: Usage = usage) => {
  const { cost, issues } = priceCall(u, { model, ...more });
  const round = (x: number) => Number(x.toFixed(12));
  return {
    usd: cost && [cost.inputUsd, cost.cacheReadUsd, cost.cacheWriteUsd, cost.outputUsd].map(round),
    cost,
    issues,
  };
};

describe("priceCall: base prices", () => {
  test("prices cache writes at 1.25x input for 5 minutes and 2x for 1 hour", () => {
    // Sonnet 4.5: $3 input, $15 output, $0.30 cache read.
    expect(parts("claude-sonnet-4-5").usd).toEqual([3, 0.3, 3 * 1.25 + 3 * 2, 15]);
    expect(parts("claude-sonnet-4-5").cost?.price).toEqual({
      model: "claude-sonnet-4-5",
      source: PRICE_SOURCE,
      date: "2026-11-12",
      modifiers: [],
    });
  });

  test("uses the model's own cache read price where it is not 0.1x", () => {
    expect(parts("claude-opus-5-5").usd?.[1]).toBe(0.2);
    expect(parts("claude-sonnet-5-5").usd?.[1]).toBe(0.1);
  });

  test.each([
    ["claude-mythos-5-2", [8, 0.2, 10 + 16, 40]],
    ["claude-mythos-5-1", [10, 0.25, 12.5 + 20, 50]],
    ["claude-mythos-5", [10, 1, 12.5 + 20, 50]],
  ])("prices %s", (model, expected) => {
    expect(parts(model).usd).toEqual(expected);
  });

  test("prices Haiku 5.5 by prompt size: the higher tier above 100 000 prompt tokens", () => {
    const small: Usage = {
      basis: "exact",
      inputTokens: 40_000,
      cacheReadTokens: 60_000,
      cacheWriteTokens: 0,
      outputTokens: M,
    };
    const large: Usage = { ...small, inputTokens: 40_001 };
    expect(parts("claude-haiku-5-5", {}, small).usd).toEqual([0.004, 0.0006, 0, 0.5]);
    expect(parts("claude-haiku-5-5", {}, large).usd).toEqual([0.0200005, 0.003, 0, 2.5]);
    expect(parts("claude-haiku-5-5", {}, large).cost?.price.modifiers).toEqual(["prompt over 100000 tokens"]);
  });

  test("has no price for an unknown model, and says so", () => {
    expect(parts("claude-unknown-9")).toEqual({
      usd: undefined,
      cost: undefined,
      issues: [{ kind: "no-price", detail: "no list price for model claude-unknown-9" }],
    });
  });
});

describe("priceCall: price modifiers", () => {
  test("adds 10% on a Bedrock regional endpoint for Claude 4.5 models and later", () => {
    const regional = parts("eu.anthropic.claude-opus-5-5");
    expect(regional.usd).toEqual([4.4, 0.22, 14.3, 22]);
    expect(regional.cost?.price.modifiers).toEqual(["Bedrock regional endpoint +10%"]);
  });

  test("adds nothing on a Bedrock global endpoint, or for a model before Claude 4.5", () => {
    expect(parts("global.anthropic.claude-opus-5-5").cost?.price.modifiers).toEqual([]);
    expect(parts("eu.anthropic.claude-opus-4-1-20250805-v1:0").cost?.price.modifiers).toEqual([]);
  });

  test("uses the fast-mode prices, with the cache multipliers on top", () => {
    // Opus 5.5 fast: $8 input, $40 output; cache read 0.05x, writes 1.25x and 2x of the fast input.
    const fast = parts("claude-opus-5-5", { speed: "fast" });
    expect(fast.usd).toEqual([8, 0.4, 10 + 16, 40]);
    expect(fast.cost?.price.modifiers).toEqual(["fast mode"]);
  });

  test("multiplies by 1.1 for US-only inference on Claude 4.6 models and later", () => {
    expect(parts("claude-opus-5-5", { inferenceGeo: "us" }).cost?.price.modifiers).toEqual(["US-only inference x1.1"]);
    expect(parts("claude-opus-5-5", { inferenceGeo: "us" }).usd?.[3]).toBe(22);
    expect(parts("claude-sonnet-4-5", { inferenceGeo: "us" }).cost?.price.modifiers).toEqual([]);
  });
});

describe("priceCall: what it has to assume", () => {
  test("flags a cache write whose time-to-live split does not add up", () => {
    const odd = { ...usage, cacheWrite1hTokens: 5 };
    expect(parts("claude-opus-5-5", {}, odd).issues).toEqual([
      { kind: "price-assumption", detail: "cache write 2000000 is not 5m 1000000 + 1h 5; priced by the split" },
    ]);
  });

  test("prices a cache write with no time-to-live split as 5 minutes, and flags it", () => {
    const { cacheWrite5mTokens: _, cacheWrite1hTokens: __, ...plain } = usage;
    const priced = parts("claude-opus-5-5", {}, plain);
    expect(priced.usd?.[2]).toBe(2 * 4 * 1.25);
    expect(priced.issues).toEqual([
      { kind: "price-assumption", detail: "cache write time to live unknown; priced as 5 minutes" },
    ]);
  });

  test("flags a long prompt on a 1M-context model whose long-context price is not verified", () => {
    const long: Usage = {
      basis: "exact",
      inputTokens: 200_001,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
    };
    expect(parts("claude-sonnet-4-5-20250929[1m]", {}, long).issues).toEqual([
      {
        kind: "price-assumption",
        detail: "prompt over 200000 tokens on claude-sonnet-4-5: long-context price not verified",
      },
    ]);
    expect(parts("claude-opus-4-8[1m]", {}, long).issues).toEqual([]);
  });
});

describe("blockCosts", () => {
  const u: Usage = { basis: "exact", inputTokens: 2, cacheReadTokens: 100, cacheWriteTokens: 40, outputTokens: 7 };
  const cost = priceCall(u, { model: "claude-opus-5-5" }).cost;

  test("prices each block by the part of the input it is in: cache read, then cache write, then plain input", () => {
    if (cost === undefined) throw new Error("no price");
    // Opus 5.5 per million: cache read $0.20, cache write (5 minutes) $5, input $4.
    const costs = blockCosts([50, 60, 30], u, cost);
    expect(costs[0]).toBeCloseTo(50 * 0.2e-6, 15);
    expect(costs[1]).toBeCloseTo(50 * 0.2e-6 + 10 * 5e-6, 15);
    expect(costs[2]).toBeCloseTo(30 * 5e-6, 15);
  });

  test("leaves the framing after the last block at the plain input price", () => {
    if (cost === undefined) throw new Error("no price");
    const total = blockCosts([50, 60, 30], u, cost).reduce((a, b) => a + b, 0);
    expect(cost.inputUsd + cost.cacheReadUsd + cost.cacheWriteUsd - total).toBeCloseTo(2 * 4e-6, 15);
  });
});
