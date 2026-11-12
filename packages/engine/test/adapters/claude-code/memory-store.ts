/** A store in memory for tests: applies deltas, answers the parser's ContentLookup, gives the graph back. */
import type {
  Block,
  Call,
  CallBlock,
  ContentLookup,
  JsonValue,
  SessionDelta,
  SessionGraph,
  ToolCall,
} from "@quantext/shared";
import { emptyGraph, mergeDelta } from "../../../src/core/graph.ts";

export class MemoryStore implements ContentLookup {
  private readonly records = new Map<string, JsonValue>();
  private readonly blocks = new Map<string, Block>();
  private readonly calls = new Map<string, Call>();
  private readonly toolCalls = new Map<string, ToolCall>();
  private readonly runs = new Map<string, CallBlock>();
  private readonly deltas: SessionDelta[] = [];

  apply(delta: SessionDelta): void {
    this.deltas.push(delta);
    for (const r of delta.records) this.records.set(r.key, r.value);
    for (const b of delta.blocks) this.blocks.set(b.hash, b);
    for (const c of delta.calls) this.calls.set(c.id, c);
    for (const t of delta.toolCalls) this.toolCalls.set(t.id, t);
    for (const r of delta.callBlocks) this.runs.set(r.id, r);
  }

  record(key: string): JsonValue | undefined {
    return structuredClone(this.records.get(key));
  }

  block(hash: string): Block | undefined {
    return this.blocks.get(hash);
  }

  call(id: string): Call | undefined {
    return this.calls.get(id);
  }

  toolCall(id: string): ToolCall | undefined {
    return this.toolCalls.get(id);
  }

  openRuns(sessionId: string, lane: string): CallBlock[] {
    return [...this.runs.values()].filter(
      (r) => r.sessionId === sessionId && r.lane === lane && r.lastCall === undefined,
    );
  }

  graph(): SessionGraph {
    return this.deltas.reduce(mergeDelta, emptyGraph());
  }
}
