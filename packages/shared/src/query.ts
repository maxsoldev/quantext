/**
 * The read API's request and response types: what the query layer gives the CLI, the HTTP API, the viewer and the
 * mod. Numbers keep their basis; optional fields are left out when absent, never null.
 */
import type {
  BlockKind,
  BlockSource,
  CallIssue,
  CallParams,
  Compaction,
  Cost,
  JsonValue,
  RequestLog,
  RequestSection,
  SessionEvent,
  TokenBasis,
  Usage,
} from "./domain.ts";

/** A Session in the store: the same id can occur in two logs (a session that went on in another folder). */
export interface SessionKey {
  log: number;
  id: string;
}

/**
 * Demo mode: only the allowed projects are visible (by path or by last folder name), and local paths are shown
 * relative to the project, or under `~`. The home folder and the user name never appear.
 */
export interface DemoOptions {
  projects?: string[];
  redactPaths: boolean;
}

/** Token counts by Usage part, summed over Calls. */
export interface TokenParts {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

/** Cost by part in US dollars, summed over the Calls that have a price. */
export interface CostParts {
  inputUsd: number;
  cacheReadUsd: number;
  cacheWriteUsd: number;
  outputUsd: number;
  totalUsd: number;
}

export interface SessionSummary extends SessionKey {
  parentId?: string;
  /** The user's own title, else the harness's. */
  title?: string;
  titleSource?: "user" | "harness";
  agentName?: string;
  harness: string;
  harnessVersion?: string;
  project?: string;
  cwd?: string;
  started?: string;
  ended?: string;
  /** Model ids as priced (else as requested), sorted. */
  models: string[];
  calls: number;
  tokens: TokenParts;
  cost: CostParts;
  /** Calls with Usage but no price: their tokens count, their cost does not. */
  unpricedCalls: number;
  /** The largest input total of one Call. */
  maxContextTokens: number;
  /** Cache read over the input total, over all Calls; absent with no input. */
  cacheHitRate?: number;
  requestLog: RequestLog;
  /** Calls by issue kind. */
  issues: Partial<Record<CallIssue["kind"], number>>;
  /** The last event is recent (`QueryOptions.liveWindowMs`). */
  live: boolean;
  /** Subagent Sessions, in `listSessions` only (on main Sessions). */
  subagents?: SessionSummary[];
}

export interface SessionFilter {
  /** Only Sessions of this project (its path or its last folder name). */
  project?: string;
  /** Only Sessions whose title or id contains this text (case-insensitive). */
  search?: string;
  sort?: "ended" | "started" | "cost" | "calls";
  order?: "asc" | "desc";
  limit?: number;
  offset?: number;
}

export interface Page<T> {
  /** Items over all pages. */
  total: number;
  offset: number;
  items: T[];
}

export interface LaneSummary {
  lane: string;
  model: string;
  calls: number;
  firstCall: number;
  lastCall: number;
}

export interface SessionDetail {
  session: SessionSummary;
  lanes: LaneSummary[];
  events: SessionEvent[];
  compactions: CompactionDetail[];
  subagents: SessionSummary[];
}

export interface CallSummary {
  id: string;
  index: number;
  lane: string;
  ts: string;
  model: string;
  params: CallParams;
  usage?: Usage;
  cost?: Cost;
  cacheBoundary?: { tokens: number; position: number };
  cacheBreakpoints: number[];
  blockCount?: number;
  framingTokens: number;
  issues: CallIssue[];
  turnDurationMs?: number;
  /** The tool uses in this Call's response. */
  toolCalls: { id: string; name: string }[];
}

/** The groups of the viewer's context bar. */
export type ContextCategory =
  | "tool-definitions"
  | "base-instructions"
  | "injected-context"
  | "user"
  | "assistant"
  | "reasoning"
  | "tool-calls"
  | "tool-outputs"
  | "compaction-summary"
  | "other";

/** One entry of a Call's input: a Block at its position, or the framing tokens after the last Block. */
export interface ContextBlock {
  position: number;
  section: RequestSection | "framing";
  /** Absent for framing. */
  hash?: string;
  kind: BlockKind | "framing";
  category: ContextCategory;
  source: BlockSource;
  message?: number;
  /** Absent for a Call with no Usage. */
  tokens?: number;
  basis?: TokenBasis | "framing";
  group?: string;
  /** Wholly inside the Cached prefix. */
  inCachedPrefix: boolean;
  /** Its share of the Call's input cost (cache read, cache write, input by token offset). */
  costUsd?: number;
  /** The display text, cut to a preview; `getBlock` gives all of it. */
  preview: string;
  /** Characters of the whole display text. */
  chars: number;
  truncated: boolean;
  /** The CallBlock run: the Calls (by index) this entry stays the same over; `lastCall` absent while open. */
  run?: { firstCall: number; lastCall?: number };
}

export interface CallContext {
  session: SessionKey;
  lane: string;
  call: CallSummary;
  /** False for a usage-only Call or one not split: its context cannot be shown. */
  rebuilt: boolean;
  blocks: ContextBlock[];
  /** Tokens by request section, and the framing tokens. */
  sections: Record<RequestSection | "framing", number>;
  categories: Record<ContextCategory, number>;
  /** The input total of the Call: the blocks and framing add up to it. */
  totalTokens: number;
}

/** What changed at Call N against the previous Call of its lane: Blocks by content and position. */
export interface ContextDiff {
  call: number;
  /** The previous Call of the lane; absent for the lane's first Call. */
  previous?: number;
  added: ContextBlock[];
  removed: ContextBlock[];
  /** Entries kept from the previous Call that are not in this Call's Cached prefix: written to the cache again. */
  uncached: ContextBlock[];
  /** The first position that differs from the previous Call. */
  firstChange?: number;
  /** Cache read tokens lost against the previous Call (0 when it did not drop). */
  cacheReadDrop: number;
}

export interface BlockDetail {
  hash: string;
  log: number;
  kind: BlockKind;
  source: BlockSource;
  /** The whole display text. */
  text: string;
  /** The content as sent, with each image or document as `{"$media": hash}`; `getMedia` gives its bytes. */
  content: JsonValue;
  media: { hash: string; mediaType: string; bytes: number }[];
}

export interface ToolCallSummary {
  id: string;
  callId: string;
  callIndex?: number;
  name: string;
  source: BlockSource;
  input: JsonValue;
  isError: boolean;
  durationMs?: number;
  parallel: number;
  childSessionId?: string;
  resultBlockHash?: string;
  /** The result's tokens in the first Call that sent it. */
  resultTokens?: number;
}

/** Blocks of a context, counted. */
export interface TokenGroup {
  blocks: number;
  tokens: number;
  categories: Record<ContextCategory, number>;
}

export interface CompactionDetail extends Compaction {
  beforeCallIndex?: number;
  summaryCallIndex?: number;
  /** The first Call of the lane after the compaction, whose context holds the summary. */
  afterCallIndex?: number;
  /** Blocks of the Call before that the Call after does not hold, and those it holds (by content). */
  removed?: TokenGroup;
  kept?: TokenGroup;
  summaryTokens?: number;
}

export interface MemoryDocumentView {
  /** In the memory folder, `/` separators. */
  path: string;
  content: string;
  mtimeMs: number;
  size: number;
}

/** What ingest could not map or read, and the Calls' issues, over the visible logs. */
export interface QueryReport {
  unknownRecords: { kind: string; count: number }[];
  ignoredRecords: { kind: string; count: number }[];
  unreadable: { log: string; at: string; reason: string }[];
  errors: { path: string; error: string }[];
  pending: { path: string; bytes: number }[];
  pendingBytes: number;
  scan: { path: string; issue: string }[];
  /** Calls by issue kind. */
  issues: Partial<Record<CallIssue["kind"], number>>;
  requestLogs: { requestLog: RequestLog; sessions: number }[];
}

/** The result of a read-only SQL statement, at most `limit` rows. */
export interface SqlResult {
  columns: string[];
  rows: { [column: string]: JsonValue }[];
  /** More rows were left out after the limit. */
  truncated: boolean;
}
