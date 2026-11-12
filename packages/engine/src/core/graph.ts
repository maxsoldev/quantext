/** Work with a SessionGraph as deltas arrive: merge them, and list the Blocks of one Call from the runs. */
import type { Call, CallBlock, SessionDelta, SessionGraph } from "@quantext/shared";

export function emptyGraph(): SessionGraph {
  return {
    sessions: [],
    calls: [],
    blocks: [],
    callBlocks: [],
    toolCalls: [],
    compactions: [],
    report: { unknownRecords: [], unreadable: [] },
  };
}

/** The graph with a delta applied: new entities added, updated ones replaced by id, report counts summed. */
export function mergeDelta(graph: SessionGraph, delta: SessionDelta): SessionGraph {
  const report = {
    unknownRecords: graph.report.unknownRecords.map((e) => ({ ...e })),
    unreadable: [...graph.report.unreadable, ...delta.report.unreadable],
  };
  for (const { kind, count } of delta.report.unknownRecords) {
    const entry = report.unknownRecords.find((e) => e.kind === kind);
    if (entry === undefined) report.unknownRecords.push({ kind, count });
    else entry.count += count;
  }
  return {
    sessions: upsert(graph.sessions, delta.sessions, (s) => s.id),
    calls: upsert(graph.calls, delta.calls, (c) => c.id),
    blocks: upsert(graph.blocks, delta.blocks, (b) => b.hash),
    callBlocks: upsert(graph.callBlocks, delta.callBlocks, (r) => r.id),
    toolCalls: upsert(graph.toolCalls, delta.toolCalls, (t) => t.id),
    compactions: upsert(graph.compactions, delta.compactions, (c) => c.id),
    report,
  };
}

function upsert<T>(current: readonly T[], next: readonly T[], key: (item: T) => string): T[] {
  const index = new Map(current.map((item, i) => [key(item), i]));
  const out = [...current];
  for (const item of next) {
    const at = index.get(key(item));
    if (at === undefined) {
      index.set(key(item), out.length);
      out.push(item);
    } else out[at] = item;
  }
  return out;
}

/**
 * The runs that make up one Call's input, in position order. A Call that was not split has none. This scans every
 * run; the store answers the same question with an interval index on (session, lane, firstCall, lastCall).
 */
export function blocksAtCall(
  runs: readonly CallBlock[],
  call: Pick<Call, "sessionId" | "lane" | "index" | "blockCount">,
): CallBlock[] {
  if (call.blockCount === undefined) return [];
  return runs
    .filter(
      (r) =>
        r.sessionId === call.sessionId &&
        r.lane === call.lane &&
        r.firstCall <= call.index &&
        (r.lastCall === undefined || call.index <= r.lastCall),
    )
    .sort((a, b) => a.position - b.position);
}
