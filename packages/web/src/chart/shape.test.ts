import { describe, expect, test } from "vitest";
import { bandOf, niceTicks, stack, stepArea } from "./shape.ts";

describe("stacking a Call's parts", () => {
  test("each part sits on the ones before it, in the given order", () => {
    const rows = [
      { a: 10, b: 5 },
      { a: 12, b: 0 },
    ];
    const s = stack(rows, ["a", "b"], (r, k) => r[k as "a" | "b"]);
    expect(s.series).toEqual([
      {
        key: "a",
        spans: [
          [0, 10],
          [0, 12],
        ],
      },
      {
        key: "b",
        spans: [
          [10, 15],
          [12, 12],
        ],
      },
    ]);
    expect(s.totals).toEqual([15, 12]);
    expect(s.max).toBe(15);
  });
});

describe("axis ticks", () => {
  test("round steps of 1, 2 or 5 that reach the maximum", () => {
    expect(niceTicks(27_783, 4)).toEqual([0, 10_000, 20_000, 30_000]);
    expect(niceTicks(605_000, 4)).toEqual([0, 200_000, 400_000, 600_000, 800_000]);
    expect(niceTicks(0, 4)).toEqual([0, 1]);
  });
});

describe("bands", () => {
  test("columns while each Call has room for a 2px gap, areas when it does not", () => {
    expect(bandOf(1000, 8)).toEqual({ step: 125, width: 24, mode: "columns" });
    expect(bandOf(1000, 100)).toEqual({ step: 10, width: 8, mode: "columns" });
    expect(bandOf(1000, 2000)).toEqual({ step: 0.5, width: 0.5, mode: "area" });
  });
});

describe("step areas", () => {
  test("one flat step per Call between its lower and upper value", () => {
    const path = stepArea(
      [
        [0, 10],
        [2, 6],
      ],
      (i) => i * 10,
      10,
      (v) => 100 - v,
    );
    expect(path).toBe("M0,90H10V94H20V98H10V100H0Z");
  });
});
