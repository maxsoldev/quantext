import { describe, expect, test } from "vitest";
import { ago, basisOf, duration, percent, tokens, usd } from "./format.ts";

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
    expect([0, 0.000061, 0.0042, 0.107, 1.5, 12.345, 1234.5].map(usd)).toEqual([
      "$0",
      "$0.000061",
      "$0.0042",
      "$0.11",
      "$1.50",
      "$12.35",
      "$1,235",
    ]);
  });

  test("shares below 10% keep one decimal so small parts do not read as 0%", () => {
    expect([0, 0.004, 0.0754, 0.776, 1].map(percent)).toEqual(["0%", "0.4%", "7.5%", "78%", "100%"]);
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
  test("durations", () => {
    expect([800, 42_000, 61_000, 7_260_000].map(duration)).toEqual(["0.8 s", "42 s", "1 min 1 s", "2 h 1 min"]);
  });
});
