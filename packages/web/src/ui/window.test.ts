import { describe, expect, test } from "vitest";
import { windowOf } from "./window.ts";

describe("the rows a scrolled list draws", () => {
  test("at the top: the visible rows and the overscan below", () => {
    expect(windowOf({ scrollTop: 0, height: 300, rowHeight: 50, count: 2000, overscan: 2 })).toEqual({
      start: 0,
      end: 8,
      before: 0,
      after: (2000 - 8) * 50,
    });
  });

  test("in the middle: overscan on both sides, padding for the rest", () => {
    expect(windowOf({ scrollTop: 1025, height: 300, rowHeight: 50, count: 2000, overscan: 2 })).toEqual({
      start: 18,
      end: 29,
      before: 18 * 50,
      after: (2000 - 29) * 50,
    });
  });

  test("never past the last row, and empty for an empty list", () => {
    expect(windowOf({ scrollTop: 99_999, height: 300, rowHeight: 50, count: 10, overscan: 2 })).toMatchObject({
      start: 8,
      end: 10,
      after: 0,
    });
    expect(windowOf({ scrollTop: 0, height: 300, rowHeight: 50, count: 0, overscan: 2 })).toEqual({
      start: 0,
      end: 0,
      before: 0,
      after: 0,
    });
  });
});
