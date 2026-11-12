import type { Call, CallBlock, SessionDelta } from "@quantext/shared";
import { describe, expect, test } from "vitest";
import { blocksAtCall, emptyGraph, mergeDelta } from "../../src/core/graph.ts";

const run = (id: string, position: number, firstCall: number, lastCall?: number, lane = "a"): CallBlock => ({
  id,
  sessionId: "s",
  lane,
  blockHash: id,
  position,
  section: "messages",
  firstCall,
  ...(lastCall === undefined ? {} : { lastCall }),
});
const call = (index: number, lane = "a") => ({ sessionId: "s", lane, index, blockCount: 2 }) as Call;

describe("blocksAtCall", () => {
  const runs = [run("x", 0, 0), run("y", 1, 0, 1), run("z", 1, 2), run("w", 0, 1, undefined, "b")];

  test("lists the runs that cover a Call, by position", () => {
    expect(blocksAtCall(runs, call(1)).map((r) => r.id)).toEqual(["x", "y"]);
    expect(blocksAtCall(runs, call(2)).map((r) => r.id)).toEqual(["x", "z"]);
  });

  test("gives a Call that was not split no blocks, also inside a run", () => {
    expect(blocksAtCall(runs, { ...call(1), blockCount: undefined } as unknown as Call)).toEqual([]);
  });

  test("covers only Calls of the run's own lane", () => {
    expect(blocksAtCall(runs, call(1, "b")).map((r) => r.id)).toEqual(["w"]);
  });
});

describe("mergeDelta", () => {
  test("adds new entities, replaces updated ones by id, and sums the report counts", () => {
    const one: SessionDelta = { ...emptyGraph(), callBlocks: [run("x", 0, 0)] };
    one.report.unknownRecords.push({ kind: "k", count: 1 });
    const two: SessionDelta = { ...emptyGraph(), callBlocks: [run("x", 0, 0, 3), run("y", 1, 0)] };
    two.report.unknownRecords.push({ kind: "k", count: 2 }, { kind: "j", count: 1 });
    two.report.unreadable.push({ at: "main:2", reason: "r" });
    const graph = mergeDelta(mergeDelta(emptyGraph(), one), two);
    expect(graph.callBlocks.map((r) => [r.id, r.lastCall])).toEqual([
      ["x", 3],
      ["y", undefined],
    ]);
    expect(graph.report).toEqual({
      unknownRecords: [
        { kind: "k", count: 3 },
        { kind: "j", count: 1 },
      ],
      unreadable: [{ at: "main:2", reason: "r" }],
    });
  });
});
