/**
 * The parser's view of content: what its state holds in memory, else what the caller kept from earlier deltas
 * (ContentLookup). Every write is also emitted as a record, so the caller can give it back after a restore from a
 * snapshot that no longer holds it.
 */
import type { AdapterRecord, BlockSource, Call, ContentLookup, JsonValue, ToolCall } from "@quantext/shared";
import { get, put } from "./records.ts";
import type { CallSpec, ParserState, WireMessage, WireShape } from "./state.ts";

/** Answers nothing: for a parser that never restores from a snapshot. */
export const NO_LOOKUP: ContentLookup = {
  record: () => undefined,
  block: () => undefined,
  call: () => undefined,
  toolCall: () => undefined,
  openRuns: () => [],
};

export class Content {
  readonly state: ParserState;
  readonly lookup: ContentLookup;
  private readonly emit: (record: AdapterRecord) => void;

  constructor(state: ParserState, lookup: ContentLookup, emit: (record: AdapterRecord) => void) {
    this.state = state;
    this.lookup = lookup;
    this.emit = emit;
  }

  message(hash: string): WireMessage | undefined {
    return this.read(this.state.messages, "m:", hash) as WireMessage | undefined;
  }

  putMessage(hash: string, message: WireMessage): WireMessage {
    return this.write(this.state.messages, "m:", hash, message);
  }

  shape(hash: string): WireShape | undefined {
    return this.read(this.state.shapes, "s:", hash) as WireShape | undefined;
  }

  putShape(hash: string, shape: WireShape): void {
    this.write(this.state.shapes, "s:", hash, shape);
  }

  spec(id: string): CallSpec | undefined {
    return this.read(this.state.specs, "p:", id) as CallSpec | undefined;
  }

  putSpec(id: string, spec: CallSpec): void {
    this.write(this.state.specs, "p:", id, spec);
  }

  groupSize(id: string): number | undefined {
    return this.read(this.state.groupSizes, "g:", id) as number | undefined;
  }

  putGroupSize(id: string, size: number): void {
    this.write(this.state.groupSizes, "g:", id, size);
  }

  toolSource(id: string): BlockSource | undefined {
    return this.read(this.state.toolSources, "t:", id) as BlockSource | undefined;
  }

  putToolSource(id: string, source: BlockSource): void {
    this.write(this.state.toolSources, "t:", id, source);
  }

  /** A Block that an earlier read reported. */
  seen(hash: string): boolean {
    return get(this.state.seenBlocks, hash) !== undefined || this.lookup.block(hash) !== undefined;
  }

  markSeen(hash: string): void {
    put(this.state.seenBlocks, hash, 1);
  }

  /** A Call, taken back into the state when only the caller still has it (so it can be updated). */
  call(id: string): Call | undefined {
    const held = get(this.state.calls, id);
    if (held !== undefined) return held;
    const kept = this.lookup.call(id);
    return kept === undefined ? undefined : put(this.state.calls, id, structuredClone(kept));
  }

  toolCall(id: string): ToolCall | undefined {
    const held = get(this.state.toolCalls, id);
    if (held !== undefined) return held;
    const kept = this.lookup.toolCall(id);
    return kept === undefined ? undefined : put(this.state.toolCalls, id, structuredClone(kept));
  }

  private read(record: Record<string, unknown>, prefix: string, key: string): unknown {
    const held = get(record, key);
    if (held !== undefined) return held;
    const kept = this.lookup.record(prefix + key);
    if (kept !== undefined) put(record, key, kept);
    return kept;
  }

  private write<T>(record: Record<string, T>, prefix: string, key: string, value: T): T {
    put(record, key, value);
    this.emit({ key: prefix + key, value: value as unknown as JsonValue });
    return value;
  }
}
