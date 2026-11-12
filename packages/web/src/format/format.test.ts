import { describe, expect, test } from "vitest";
import { ago, basisOf, count, duration, percent, tokens, usd } from "./format.ts";

describe("numbers", () => {
  test("tokens are in full under 10,000 and compact above", () => {
    expect([0, 950, 9_999, 12_345, 123_456, 1_234_567].map(tokens)).toEqual([
      "0",
      "950",
      "9,999",
      "12.3k",
      "123k",
      "1.23M",
    ]);
  });

  test("dollars keep two significant digits below a dollar", () => {
    expect([0, 0.000061, 0.0042, 0.1, 0.107, 1.5, 12.345, 1234.5].map(usd)).toEqual([
      "$0",
      "$0.000061",
      "$0.0042",
      "$0.10",
      "$0.11",
      "$1.50",
      "$12.35",
      "$1,235",
    ]);
  });

  test("shares below 10% keep one decimal so small parts do not read as 0%", () => {
    expect([0, 0.00001, 0.004, 0.0754, 0.776, 1].map(percent)).toEqual(["0%", "<0.1%", "0.4%", "7.5%", "78%", "100%"]);
  });
});

describe("token basis", () => {
  test("each basis has a mark and a one-line explanation", () => {
    expect(basisOf("exact")).toMatchObject({ mark: "", label: "exact" });
    expect(basisOf("anchored")).toMatchObject({ mark: "≈", label: "anchored" });
    expect(basisOf("estimate")).toMatchObject({ mark: "~", label: "estimate" });
    expect(basisOf("derived")).toMatchObject({ mark: "Δ", label: "derived" });
    expect(basisOf("framing").explain).toMatch(/after the last Block/);
    for (const b of ["exact", "anchored", "estimate", "derived"] as const)
      expect(basisOf(b).explain.length).toBeGreaterThan(20);
  });
});

describe("time", () => {
  const now = Date.parse("2026-11-12T12:00:00Z");
  test("ago reads in the largest whole unit", () => {
    expect(ago("2026-11-12T11:59:40Z", now)).toBe("just now");
    expect(ago("2026-11-12T11:55:00Z", now)).toBe("5 min ago");
    expect(ago("2026-11-12T09:00:00Z", now)).toBe("3 h ago");
    expect(ago("2026-11-09T12:00:00Z", now)).toBe("3 days ago");
  });
  test("a count with its noun", () => {
    expect([count(1, "call"), count(2, "call"), count(1200, "entry", "entries")]).toEqual([
      "1 call",
      "2 calls",
      "1,200 entries",
    ]);
  });

  test("durations", () => {
    expect([35, 800, 1500, 42_000, 61_000, 7_260_000, 545_940_000].map(duration)).toEqual([
      "35 ms",
      "800 ms",
      "1.5 s",
      "42 s",
      "1 min 1 s",
      "2 h 1 min",
      "6 days 7 h",
    ]);
  });
});

describe("names", () => {
  test("models lose their provider prefix and date", async () => {
    const { shortModel } = await import("./format.ts");
    expect(shortModel("claude-opus-5-5")).toBe("opus-5-5");
    expect(shortModel("eu.anthropic.claude-sonnet-4-5-20250929-v1:0")).toBe("sonnet-4-5");
    expect(shortModel("gpt-5")).toBe("gpt-5");
  });
  test("a project is named by its last folder", async () => {
    const { projectName } = await import("./format.ts");
    expect(projectName("/fixture-0/repo")).toBe("repo");
    expect(projectName("C:\\work\\app\\")).toBe("app");
  });
});
