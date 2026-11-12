import type { CacheBreak, TimelineCall } from "@quantext/shared";
import { describe, expect, test } from "vitest";
import { laneView, mainLane } from "./lane.ts";

const call = (index: number, lane: string, extra: Partial<TimelineCall> = {}): TimelineCall => ({
  index,
  lane,
  ts: `2026-11-12T00:00:0${index}Z`,
  model: "m",
  rebuilt: true,
  sections: { tools: 0, system: 0, messages: 0, framing: 0 },
  categories: {
    "tool-definitions": 0,
    "base-instructions": 0,
    "injected-context": 0,
    user: 0,
    assistant: 0,
    reasoning: 0,
    "tool-calls": 0,
    "tool-outputs": 0,
    "compaction-summary": 0,
    other: 0,
  },
  issues: [],
  ...extra,
});

describe("the lane a chart shows", () => {
  test("the main lane is the one with the most Calls", () => {
    expect(
      mainLane([
        { lane: "side", model: "h", calls: 2, firstCall: 0, lastCall: 5 },
        { lane: "main", model: "o", calls: 9, firstCall: 1, lastCall: 10 },
      ]),
    ).toBe("main");
    expect(mainLane([])).toBeUndefined();
  });

  test("keeps the lane's Calls in order and places markers by their place in it", () => {
    const calls = [
      call(0, "main"),
      call(1, "side"),
      call(2, "main", { compaction: "summary" }),
      call(3, "main", { compaction: "after" }),
      call(4, "main"),
    ];
    const breaks = [
      { index: 3, lane: "main", reason: "compaction", dropTokens: 900 },
      { index: 1, lane: "side", reason: "ttl", dropTokens: 5 },
    ] as CacheBreak[];
    const v = laneView(calls, breaks, "main");
    expect(v.calls.map((c) => c.index)).toEqual([0, 2, 3, 4]);
    expect(v.at(3)).toBe(2);
    expect(v.at(1)).toBeUndefined();
    expect(v.compactions).toEqual([{ at: 2, index: 3 }]);
    expect(v.breaks.map((b) => [b.at, b.reason])).toEqual([[2, "compaction"]]);
  });

  test("the nearest Call of the lane to an index of another lane", () => {
    const v = laneView([call(0, "main"), call(1, "side"), call(2, "side"), call(5, "main")], [], "main");
    expect(v.nearest(1)).toBe(0);
    expect(v.nearest(4)).toBe(0);
    expect(v.nearest(5)).toBe(1);
    expect(v.nearest(99)).toBe(1);
  });
});
