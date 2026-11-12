/** Read a SessionGraph call by call, as the query layer will: the runs and Blocks of one Call. */
import type { Block, Call, CallBlock, SessionGraph } from "@quantext/shared";
import { blocksAtCall } from "../../../src/core/graph.ts";

export function runsAt(graph: SessionGraph, call: Call | undefined): CallBlock[] {
  return call === undefined ? [] : blocksAtCall(graph.callBlocks, call);
}

export function blocksAt(graph: SessionGraph, call: Call | undefined): Block[] {
  const byHash = new Map(graph.blocks.map((b) => [b.hash, b]));
  return runsAt(graph, call).flatMap((r) => byHash.get(r.blockHash) ?? []);
}

export function inCachedPrefix(run: CallBlock, call: Call | undefined): boolean {
  return run.position < (call?.cacheBoundary?.position ?? 0);
}

export const tokensOf = (runs: readonly CallBlock[]) => runs.reduce((sum, r) => sum + (r.tokens ?? 0), 0);

export const inputTotal = (call: Call | undefined) =>
  (call?.usage?.inputTokens ?? 0) + (call?.usage?.cacheReadTokens ?? 0) + (call?.usage?.cacheWriteTokens ?? 0);
