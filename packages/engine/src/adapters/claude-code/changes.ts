/** Collect what one read adds or changes, and turn it into a SessionDelta. */
import type {
  AdapterRecord,
  Block,
  CallBlock,
  CallIssue,
  IngestReport,
  SessionDelta,
  SessionEvent,
} from "@quantext/shared";
import { get } from "./records.ts";
import type { ParserState } from "./state.ts";

export class Changes {
  readonly sessions = new Set<string>();
  readonly calls = new Set<string>();
  readonly toolCalls = new Set<string>();
  readonly compactions = new Set<string>();
  readonly blocks: Block[] = [];
  readonly runs = new Map<string, CallBlock>();
  /** Records by key: a later write of the same key in one read replaces the earlier. */
  readonly records = new Map<string, AdapterRecord>();
  readonly events: SessionEvent[] = [];
  readonly report: IngestReport = { unknownRecords: [], ignoredRecords: [], unreadable: [] };

  run(run: CallBlock): void {
    this.runs.set(run.id, run);
  }

  /** The delta, as copies: later reads must not change what the caller holds. */
  delta(state: ParserState): SessionDelta {
    const pick = <T>(record: Record<string, T>, ids: Set<string>) =>
      [...ids].flatMap((id) => {
        const item = get(record, id);
        return item === undefined ? [] : [item];
      });
    const calls = pick(state.calls, this.calls);
    for (const call of calls) call.issues.sort(byKindAndDetail); // one order, however the rows came
    return structuredClone({
      sessions: pick(state.sessions, this.sessions),
      calls,
      blocks: this.blocks,
      callBlocks: [...this.runs.values()],
      toolCalls: pick(state.toolCalls, this.toolCalls),
      compactions: pick(state.compactions, this.compactions),
      events: this.events,
      report: this.report,
      records: [...this.records.values()],
    });
  }
}

function byKindAndDetail(a: CallIssue, b: CallIssue): number {
  return a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : a.detail < b.detail ? -1 : a.detail > b.detail ? 1 : 0;
}
