import type { SessionSummary } from "@quantext/shared";
import { describe, expect, test } from "vitest";
import { mergeSessions } from "./merge.ts";

const s = (id: string, ended: string, calls = 1, all = calls): SessionSummary =>
  ({
    log: 1,
    id,
    ended,
    started: ended,
    calls,
    cost: { totalUsd: calls },
    totals: { all: { cost: { totalUsd: all } } },
  }) as SessionSummary;

describe("merging changed Sessions into the loaded list", () => {
  const list = [s("c", "2026-11-12T03:00:00Z"), s("b", "2026-11-12T02:00:00Z"), s("a", "2026-11-12T01:00:00Z")];

  test("a changed Session replaces its row and moves to its place in the order", () => {
    const out = mergeSessions(list, [s("a", "2026-11-12T04:00:00Z")], "ended");
    expect(out.map((x) => x.id)).toEqual(["a", "c", "b"]);
  });

  test("a new Session is added in its place; the others keep theirs", () => {
    const out = mergeSessions(list, [s("d", "2026-11-12T02:30:00Z")], "ended");
    expect(out.map((x) => x.id)).toEqual(["c", "d", "b", "a"]);
  });

  test("by calls: most first, ties by log then id as the engine sorts", () => {
    const out = mergeSessions([s("x", "", 5), s("y", "", 2)], [s("w", "", 2)], "calls");
    expect(out.map((x) => x.id)).toEqual(["x", "w", "y"]);
  });

  test("by cost: the total with the subagents, as the engine sorts", () => {
    const out = mergeSessions([s("x", "", 5, 5), s("y", "", 2, 2)], [s("w", "", 1, 9)], "cost");
    expect(out.map((x) => x.id)).toEqual(["w", "x", "y"]);
  });
});
