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

/** The version of these response types; it changes when a field is renamed or removed. */
export type ApiVersion = 1;

/** On every response object. */
export interface Meta {
  apiVersion: ApiVersion;
}

/** A Session in the store: the same id can occur in two logs (a session that went on in another folder). */
export interface SessionKey {
  log: number;
  id: string;
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

/** Tokens and cost of a group of Sessions: one Session, its subagents, or both. */
export interface SessionTotal {
  sessions: number;
  calls: number;
  tokens: TokenParts;
  cost: CostParts;
  /** Calls with Usage but no price. */
  unpricedCalls: number;
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
  /** The largest input total of one Call with exact usage (a summarising Call's derived usage is left out). */
  maxContextTokens: number;
  /** Cache read over the input total, over all Calls; absent with no input. */
  cacheHitRate?: number;
  requestLog: RequestLog;
  /** Calls by issue kind. */
  issues: Partial<Record<CallIssue["kind"], number>>;
  /** The last event is recent (`QueryOptions.liveWindowMs`). */
  live: boolean;
  /**
   * `main`: this Session's own Calls (as `tokens` and `cost`); `subagents`: its subagents at any depth; `all`:
   * both. The session list sorts by `all` cost.
   */
  totals: { main: SessionTotal; subagents: SessionTotal; all: SessionTotal };
  /** Subagent Sessions, in `listSessions` only (on main Sessions). */
  subagents?: SessionSummary[];
}

/** A project with main Sessions in the store; `project` as `SessionSummary.project` shows it. */
export interface ProjectSummary {
  project: string;
  /** Main Sessions (not subagents). */
  sessions: number;
  /** The latest end (or start) of one of them. */
  ended?: string;
}

export interface SessionFilter {
  /** Only Sessions of this project (its path or its last folder name). */
  project?: string;
  /** Only Sessions whose title or id contains this text (case-insensitive). */
  search?: string;
  sort?: "ended" | "started" | "cost" | "calls";
  order?: "asc" | "desc";
  /** Only Sessions changed after this change cursor (`Page.cursor`, or a "calls added" event's). */
  changedSince?: number;
  limit?: number;
  offset?: number;
}

export interface Page<T> extends Meta {
  /** Items over all pages. */
  total: number;
  /** Items before this page. */
  offset: number;
  items: T[];
  /** `listSessions`: the store's change cursor when the page was read; pass it as `changedSince` to get what changed. */
  cursor?: number;
}

export interface LaneSummary {
  lane: string;
  model: string;
  calls: number;
  firstCall: number;
  lastCall: number;
}

export interface SessionDetail extends Meta {
  session: SessionSummary;
  lanes: LaneSummary[];
  events: SessionEvent[];
  compactions: CompactionDetail[];
  subagents: SessionSummary[];
  /** An estimate of the calls of the harness that no transcript holds; never part of the exact totals. */
  unlogged: UnloggedEstimate;
}

/**
 * An upper estimate of Claude Code's subagent progress summaries: billed model calls written to no transcript. It
 * assumes they were on (`CLAUDE_CODE_DISABLE_AGENT_PROGRESS_SUMMARIES` unset), which a transcript cannot show.
 * Priced like each subagent's own Calls.
 */
export interface UnloggedEstimate {
  calls: number;
  cacheReadTokens: number;
  costUsd: number;
  /** Summaries of subagents with no priced Call: counted, but not in `costUsd`. */
  unpricedCalls: number;
  /** Subagents (at any depth) with at least one summary. */
  subagents: number;
}

/** The parameters of a Call that every provider has; the provider's own are in `CallDetail.raw`. */
export type StableCallParams = Omit<CallParams, "provider">;

export interface CallSummary {
  id: string;
  index: number;
  lane: string;
  ts: string;
  model: string;
  params: StableCallParams;
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
  /** A tool schema sent in the messages, not with the request's tools: a deferred tool that a tool search loaded. */
  deferred?: true;
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
  /** The attached texts the Block holds (Block parts), in order, when it holds any. */
  parts?: ContextPart[];
  /** The Call (by index) whose Response this Block is: its answer, sent back as input from the next Call on. */
  fromResponseOf?: number;
  /** The turn (`ContextTurn.turn`) that holds this Block; messages only. */
  turn?: number;
}

/**
 * One turn of the messages: a prompt (a text the user typed) and all that follows it, up to the lead-in of the next
 * prompt (the Blocks the harness sends with that prompt, after the last answer). What comes before the first
 * prompt joins the first turn, unless the model answered there already (after a Compaction): then it is a turn
 * with no prompt.
 */
export interface ContextTurn {
  /** 1 for the first turn of this context. */
  turn: number;
  /** The position of its first Block; its Blocks follow one another. */
  start: number;
  blocks: number;
  tokens: number;
  /** Its tokens in the Cached prefix. */
  cachedTokens: number;
  /** The user text the model answers: the last one before the answer. Absent for a turn with no prompt. */
  prompt?: { position: number; preview: string };
}

/**
 * One part of a Block's text, with its share of the Block's tokens: an estimate by characters, reconciled so the
 * parts add up to the Block's tokens. A Block's only part has the Block's tokens and basis.
 */
export interface ContextPart {
  label: string;
  source: BlockSource;
  /** Offsets in the Block's display text. */
  start: number;
  end: number;
  /** Absent for a Call with no Usage. */
  tokens?: number;
  basis?: TokenBasis;
  preview: string;
  chars: number;
  truncated: boolean;
}

/** The tokens of the parts with one label in one category: a part of that category's total. */
export interface PartTotal {
  category: ContextCategory;
  label: string;
  tokens: number;
}

export interface CallContext extends Meta {
  session: SessionKey;
  lane: string;
  call: CallSummary;
  /** False for a usage-only Call or one not split: its context cannot be shown. */
  rebuilt: boolean;
  blocks: ContextBlock[];
  /** Tokens by request section, and the framing tokens. */
  sections: Record<RequestSection | "framing", number>;
  categories: Record<ContextCategory, number>;
  /** Tokens by part label within each category, most first (estimates, except a Block's only part). */
  partTotals: PartTotal[];
  /** The turns of the messages, in order; empty when the context is not rebuilt. */
  turns: ContextTurn[];
  /** The input total of the Call: the blocks and framing add up to it. */
  totalTokens: number;
}

/**
 * What changed at Call N against the previous Call of its lane, or the previous Call in time when that one ran on
 * another model: Blocks by content and position.
 */
export interface ContextDiff extends Meta {
  call: number;
  /** The previous Call of the lane; absent for the lane's first Call. */
  previous?: number;
  added: ContextBlock[];
  removed: ContextBlock[];
  /** Content in both Calls at another position: `from` is its position in the previous Call. */
  moved: (ContextBlock & { from: number })[];
  /** Entries kept from the previous Call that are not in this Call's Cached prefix: written to the cache again. */
  uncached: ContextBlock[];
  /** The previous Call ran on another model (in another lane): nothing of its cache could be read. */
  modelSwitch?: true;
  /** The first position that differs from the previous Call. */
  firstChange?: number;
  /** Cache read tokens lost against the previous Call (0 when it did not drop). */
  cacheReadDrop: number;
}

export interface BlockDetail extends Meta {
  hash: string;
  log: number;
  kind: BlockKind;
  source: BlockSource;
  /** The whole display text. */
  text: string;
  media: { hash: string; mediaType: string; bytes: number }[];
  /**
   * Not stable: the content as the provider takes it, with each image or document as `{"$media": hash}` (its bytes
   * from `getMedia`). Its shape is the provider's and changes with it.
   */
  raw: { content: JsonValue };
}

/** One Block of a Call's Response, for display; `getBlock` gives all of its text. */
export interface ResponseEntry {
  hash: string;
  kind: BlockKind;
  category: ContextCategory;
  source: BlockSource;
  /** Reasoning: whether the log holds its text (`full`), only a signature (`omitted`), or an encrypted form. */
  reasoning?: "full" | "omitted" | "redacted";
  /** A tool call: its tool use id (a `ToolCallSummary.id`) and tool. */
  toolCall?: { id: string; name: string };
  /** The display text, cut to a preview. */
  preview: string;
  chars: number;
  truncated: boolean;
  /**
   * Its share of the Call's output tokens and output cost (absent without Usage): by characters, basis `estimate`;
   * the reasoning part when the provider reports it; an only Block takes all, with the Call's basis.
   */
  tokens?: number;
  basis?: TokenBasis;
  costUsd?: number;
}

/** What the model answered on Call N: the Blocks of its output in order, why it stopped, and what it cost. */
export interface CallResponseDetail extends Meta {
  session: SessionKey;
  call: CallSummary;
  /** False while the log holds no answer for the Call (it is still being written, or was never logged). */
  answered: boolean;
  blocks: ResponseEntry[];
  /** In the provider's words: `end_turn`, `tool_use`, `max_tokens`, … */
  stopReason?: string;
  /** From the Call's Usage (absent without it); the reasoning part when the provider reports it. */
  outputTokens?: number;
  reasoningOutputTokens?: number;
  /** The output part of the Call's cost. */
  outputUsd?: number;
}

export interface CallDetail extends Meta {
  call: CallSummary;
  /** Not stable: the parameters as the provider names them (for Anthropic: `thinking`, `betas`). */
  raw: { params: CallParams };
}

export interface CallListOptions {
  lane?: string;
  /** Only Calls with a larger index. */
  afterIndex?: number;
  /** At most this many (default 1000). */
  limit?: number;
}

/** One Call on a Session's timeline: its numbers and what its context holds, by group, without its Blocks. */
export interface TimelineCall {
  index: number;
  lane: string;
  ts: string;
  model: string;
  usage?: Usage;
  cost?: CostParts;
  cacheBoundary?: { tokens: number; position: number };
  /** False for a Call whose context cannot be rebuilt (no request, not split). */
  rebuilt: boolean;
  sections: Record<RequestSection | "framing", number>;
  categories: Record<ContextCategory, number>;
  /** The kinds of its issues, in order. */
  issues: CallIssue["kind"][];
  /** `summary`: the Call that wrote a compaction's summary; `after`: the first Call of the lane after it. */
  compaction?: "summary" | "after";
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
  /** The result's tokens in the first Call that sent it, and how they were found. */
  resultTokens?: number;
  resultBasis?: TokenBasis;
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
export interface QueryReport extends Meta {
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
export interface SqlResult extends Meta {
  columns: string[];
  rows: { [column: string]: JsonValue }[];
  /** More rows were left out after the limit. */
  truncated: boolean;
}

/** A list response. */
export interface Items<T> extends Meta {
  items: T[];
}

/** How to sort and cap a lifetime list: by cost (default), lifetime tokens, or Calls; most first. */
export interface LifetimeOptions {
  sort?: "cost" | "tokens" | "calls";
  limit?: number;
}

/** Token counts and cost of a Block over the Calls it was sent in, by price part. */
export interface Lifetime {
  /** Calls it was sent in, and the runs (positions over Calls) it had. */
  calls: number;
  runs: number;
  /** Its tokens in one Call (the largest, when they changed). */
  tokens?: number;
  lifetimeTokens: number;
  tokensByPart: { cacheRead: number; cacheWrite: number; input: number };
  costUsd: { cacheRead: number; cacheWrite: number; input: number; total: number };
}

export interface BlockLifetime extends Lifetime {
  hash: string;
  kind: BlockKind;
  source: BlockSource;
}

/** A tool use with its result Block's lifetime in the Session. */
export interface ToolOutput extends Lifetime {
  toolUseId: string;
  tool: string;
  source: BlockSource;
  isError: boolean;
  callIndex?: number;
  /** The first 200 characters of the input, as JSON. */
  inputSummary?: string;
  resultBlockHash?: string;
  /** The Calls (by index) its result stayed in. */
  firstCall?: number;
  lastCall?: number;
  /**
   * The ToolCall's own Block (the tool use the model wrote: its input) over the Calls that sent it back as input;
   * absent when no Call holds it.
   */
  toolCall?: Lifetime & { blockHash: string; basis?: TokenBasis };
}

/** Why the cache read dropped: the first that fits, in this order. */
export type CacheBreakReason = "compaction" | "model-switch" | "ttl" | "prefix-change";

/** A Call whose cache read dropped against the previous Call (`ContextDiff` tells what changed). */
export interface CacheBreak {
  index: number;
  lane: string;
  ts: string;
  model: string;
  previous: { index: number; ts: string; model: string; cacheReadTokens: number };
  gapSeconds: number;
  cacheReadTokens: number;
  dropTokens: number;
  cacheWriteTokens: number;
  /** Where the Cached prefix ended, and the Block there. */
  breakPosition?: number;
  breakBlock?: { hash: string; kind: BlockKind; tool?: string };
  reason: CacheBreakReason;
}
