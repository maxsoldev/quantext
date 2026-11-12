import type { SessionSummary, SessionTotal } from "@quantext/shared";
import { describe, expect, test } from "vitest";
import { costSplit, subagentName } from "./totals.ts";

const total = (usd: number, sessions = 1): SessionTotal => ({
  sessions,
  calls: 1,
  tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
  cost: { inputUsd: 0, cacheReadUsd: usd, cacheWriteUsd: 0, outputUsd: 0, totalUsd: usd },
  unpricedCalls: 0,
});
const session = (id: string, main: number, sub: number, subs = 0, agentName?: string): SessionSummary =>
  ({
    log: 1,
    id,
    agentName,
    cost: total(main).cost,
    totals: { main: total(main), subagents: total(sub, subs), all: total(main + sub, subs + 1) },
  }) as SessionSummary;

describe("the cost split of a Session and its subagents", () => {
  test("names the main conversation, the subagents' count and sum, and the most expensive first", () => {
    const kids = [
      session("a", 1, 0, 0, "Explore"),
      session("b", 5, 3, 1, "Plan"),
      session("c", 2, 0),
      session("d", 0.5, 0),
    ];
    const s = session("m", 10, 11.5, 5);
    const split = costSplit(s, kids, 3);
    expect(split.total).toBe(21.5);
    expect(split.lines).toEqual([
      "Main conversation: $10.00",
      "5 subagents (all depths): $11.50",
      "Subagents, most expensive first:",
      "  Plan: $8.00 (with its 1 subagent)",
      "  c: $2.00",
      "  Explore: $1.00",
      "  and 1 more: $0.50",
    ]);
  });

  test("a Session with no subagents has no split", () => {
    const split = costSplit(session("m", 4, 0), [], 3);
    expect(split).toEqual({ total: 4, lines: [] });
  });

  test("names a subagent by its agent name, title, else the end of its id", () => {
    expect(subagentName({ id: "x:agent-1", agentName: "Explore" } as SessionSummary)).toBe("Explore");
    expect(subagentName({ id: "x:agent-1", title: "Look" } as SessionSummary)).toBe("Look");
    expect(subagentName({ id: "x:agent-1" } as SessionSummary)).toBe("agent-1");
  });
});
