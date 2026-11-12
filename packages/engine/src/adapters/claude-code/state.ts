/**
 * The parser's state between reads. Plain JSON, so ingest can persist it and parse a growing file from where it
 * stopped. Runtime caches (classified messages and shapes) are not part of it; they are rebuilt on demand.
 */
import type {
  BlockSource,
  Call,
  CallBlock,
  Compaction,
  IngestReport,
  RequestSection,
  Session,
  TokenBasis,
  ToolCall,
} from "@quantext/shared";
import type { Estimate } from "../../core/estimate.ts";
import type { Json, JsonObject } from "./json.ts";

export interface ParserState {
  version: 1;
  transcripts: Record<string, TranscriptState>;
  /** Every message a `tail` may name, by its hash. */
  messages: Record<string, WireMessage>;
  /** The content of each assistant message so far, by `message.id` (one row per content block). */
  assistant: Record<string, Json[]>;
  shapes: Record<string, WireShape>;
  /** The request of every logged call, as the log gives it. */
  specs: Record<string, CallSpec>;
  sessions: Record<string, Session>;
  calls: Record<string, Call>;
  /** The next Call index of each Session. */
  nextIndex: Record<string, number>;
  /** Calls with a complete request that wait for their response. */
  pending: Record<string, 1>;
  /** Calls whose request is not complete yet, with their transcript: a later row may bring the missing part. */
  waiting: Record<string, string>;
  lanes: Record<string, Lane>;
  /** The size of each group of Blocks split from one exact total. */
  groupSizes: Record<string, number>;
  toolCalls: Record<string, ToolCall>;
  /** The row time of each tool use, and the tool uses of each assistant message. */
  toolUseTimes: Record<string, string>;
  messageToolUses: Record<string, string[]>;
  /** The source of each tool use seen in a request, by tool use id. */
  toolSources: Record<string, BlockSource>;
  /** The last `@file` reminder of a tool call, for the result reminder after it. */
  lastFileCall?: BlockSource;
  /** Hashes of the Blocks already reported. */
  seenBlocks: Record<string, 1>;
  compactions: Record<string, Compaction>;
  /** Hashes of compaction summary texts, and of skill texts with the skill's name. */
  summaries: Record<string, 1>;
  skills: Record<string, string>;
  /** Subagents: the tool use that started each agent id; the agent id and meta tool use of each transcript. */
  agentToolUse: Record<string, string>;
  transcriptAgent: Record<string, string>;
  metaToolUse: Record<string, string>;
  /** The response of each call: the hash of its message so far and its output tokens, for the next call's estimate. */
  responses: Record<string, { messageId: string; hash?: string; outputTokens: number; reasoningTokens?: number }>;
  /** Per Session: whether it has Calls with a logged request (`r`), usage-only Calls (`u`), or both. */
  requestLogs: Record<string, { r?: 1; u?: 1 }>;
  report: IngestReport;
}

export interface TranscriptState {
  /** Text after the last newline: a line that is not complete yet. */
  buffer: string;
  lines: number;
  /** Adjacent user rows since the last assistant row; the API joins them into one message. */
  userRun: Json[][];
  /** The message ids of the latest assistant rows, newest last: their later rows add to them (bounded). */
  openAssistantIds: string[];
  /** The last Call logged in the transcript. */
  lastCallId?: string;
  /** The running totals of the last `cost-state` row, and the Usage of the Calls logged since, per model. */
  costTotals?: JsonObject;
  usageSinceCost: Record<string, UsageSum>;
  /** A compaction whose summarising usage waits for the next `cost-state` row. */
  openCompaction?: { summaryCallId: string; before?: JsonObject; logged: Record<string, UsageSum>; preTokens?: number };
}

/** The sum of the Usage counters of some Calls, by the names of `cost-state`'s counters. */
export type UsageSum = Record<string, number>;

export interface WireMessage {
  role: string;
  content: Json[];
}

export interface WireShape {
  system: Json[];
  tools: Json[];
}

export interface CallSpec {
  sessionId: string;
  baseId?: string;
  keep: number;
  tail: string[];
  /** keep + tail length: the number of messages. */
  length: number;
  shapeHash?: string;
  breakpoints: (string | number)[][];
  lane: string;
}

/**
 * The input of the latest split Call of one lane, position by position. Kept Blocks of the next Call keep their
 * place and tokens, so splitting a Call is work in proportion to what changed.
 */
export interface Lane {
  key: string;
  sessionId: string;
  /** Restored from a snapshot: the layout below is empty until it is rebuilt from the open runs. */
  cold?: true;
  lastIndex?: number;
  lastCallId?: string;
  shapeKey?: string;
  shapeCount: number;
  messages: string[];
  /** The number of Blocks up to the end of each message. */
  messageEnds: number[];
  blocks: string[];
  sections: RequestSection[];
  messageOf: number[];
  contentOf: number[];
  tokens: number[];
  basis: TokenBasis[];
  group: (string | null)[];
  estimates: Estimate[];
  /** prefix[i]: the tokens of Blocks [0, i). lone[i]: Blocks in [0, i) that are estimates in no group. */
  prefix: number[];
  lone: number[];
  /** The open run at each position, and whether the Block there is reasoning. */
  runs: CallBlock[];
  reasoning: boolean[];
  /** Members of each group in the layout, and the groups that lost members. */
  groupCount: Record<string, number>;
  partial: Record<string, 1>;
  /** Deferred tool schemas placed after a tool reference: position, tool name and schema hash. */
  deferred: { position: number; tool: string; hash: string }[];
}

export function emptyState(): ParserState {
  return {
    version: 1,
    transcripts: {},
    messages: {},
    assistant: {},
    shapes: {},
    specs: {},
    sessions: {},
    calls: {},
    nextIndex: {},
    pending: {},
    waiting: {},
    lanes: {},
    groupSizes: {},
    toolCalls: {},
    toolUseTimes: {},
    messageToolUses: {},
    toolSources: {},
    seenBlocks: {},
    compactions: {},
    summaries: {},
    skills: {},
    agentToolUse: {},
    transcriptAgent: {},
    metaToolUse: {},
    responses: {},
    requestLogs: {},
    report: { unknownRecords: [], unreadable: [] },
  };
}
