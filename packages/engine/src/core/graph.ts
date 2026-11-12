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
    events: [],
    report: { unknownRecords: [], ignoredRecords: [], unreadable: [] },
  };
}

/** The graph with a delta applied: new entities added, updated ones replaced by id, report counts summed. */
export function mergeDelta(graph: SessionGraph, delta: SessionDelta): SessionGraph {
  const report = {
    unknownRecords: addCounts(graph.report.unknownRecords, delta.report.unknownRecords),
    ignoredRecords: addCounts(graph.report.ignoredRecords, delta.report.ignoredRecords),
    unreadable: [...graph.report.unreadable, ...delta.report.unreadable],
  };
  return {
    sessions: upsert(graph.sessions, delta.sessions, (s) => s.id),
    calls: upsert(graph.calls, delta.calls, (c) => c.id),
    blocks: upsert(graph.blocks, delta.blocks, (b) => b.hash),
    callBlocks: upsert(graph.callBlocks, delta.callBlocks, (r) => r.id),
    toolCalls: upsert(graph.toolCalls, delta.toolCalls, (t) => t.id),
    compactions: upsert(graph.compactions, delta.compactions, (c) => c.id),
    events: upsert(graph.events, delta.events, (e) => e.id),
    report,
  };
}

/** Counts by kind, summed; kinds keep the order they were first seen in. */
export function addCounts(
  total: readonly { kind: string; count: number }[],
  more: readonly { kind: string; count: number }[],
): { kind: string; count: number }[] {
  const out = total.map((e) => ({ ...e }));
  for (const { kind, count } of more) {
    const entry = out.find((e) => e.kind === kind);
    if (entry === undefined) out.push({ kind, count });
    else entry.count += count;
  }
  return out;
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
 * run; the store answers the same question with one range lookup on the runs' key (log, session, lane, firstCall,
 * position).
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
