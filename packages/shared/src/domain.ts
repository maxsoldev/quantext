/**
 * The harness-neutral domain model (docs/ARCHITECTURE.md, docs/GLOSSARY.md). Adapters produce it, every layer
 * above reads it. No harness row names or shapes appear here.
 */

/**
 * How a token number was found. `exact`: reported by the model provider for this Call. `derived`: computed from
 * exact counters (for example the change of a cumulative total). `anchored`: an exact change less the previous
 * reply's output tokens, so near-exact (off by tens of tokens, with a known bias). `estimate`: from an estimator,
 * used only to split an exact or derived total.
 */
export type TokenBasis = "exact" | "derived" | "anchored" | "estimate";

/** One conversation in a harness. A subagent run is its own Session, with a parent. */
export interface Session {
  id: string;
  /** The Session that started this one (subagents). */
  parentId?: string;
  harness: string;
  harnessVersion?: string;
  /** The project folder the Session ran in. */
  project?: string;
  cwd?: string;
  /** ISO 8601 timestamps of the first and the last logged event. */
  started?: string;
  ended?: string;
}

/** The parameters of a Call that are not part of its Shape. The model is `Call.model`. */
export interface CallParams {
  maxTokens?: number;
  effort?: string;
  /** How the model may reason before it answers: the provider's mode, and a token budget when it has one. */
  reasoning?: { mode: string; budgetTokens?: number };
  /** Parameters only one model provider has (for Anthropic: `thinking`, `betas`), as the provider names them. */
  provider?: { [key: string]: JsonValue };
}

/** The token counts of one Call. The four input-side parts add up to the Call's input total. */
export interface Usage {
  basis: Extract<TokenBasis, "exact" | "derived">;
  /** Input tokens that were neither read from nor written to the cache. */
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** The cache write split by time to live, when the provider reports it. */
  cacheWrite5mTokens?: number;
  cacheWrite1hTokens?: number;
  outputTokens: number;
  /** The part of the output tokens spent on reasoning, when the provider reports it. */
  reasoningOutputTokens?: number;
}

/** The price of one Call, by part, in US dollars. */
export interface Cost {
  inputUsd: number;
  cacheReadUsd: number;
  cacheWriteUsd: number;
  outputUsd: number;
  totalUsd: number;
  /** The price list entry used: model, source and date. */
  price: PriceRef;
}

export interface PriceRef {
  model: string;
  source: string;
  date: string;
  /** The price modifiers that applied (regional endpoint, fast mode, US-only inference, prompt-size tier). */
  modifiers: string[];
}

/** One request from the harness to the model, with its response and Usage. */
export interface Call {
  id: string;
  sessionId: string;
  /** 0-based position in its Session. */
  index: number;
  ts: string;
  /** The model id as the harness requested it (may carry a provider prefix or suffix). */
  model: string;
  /** The provider-neutral model id, used for prices; undefined when the id is not known. */
  canonicalModel?: string;
  params: CallParams;
  shapeHash?: string;
  /** Absent when the log holds no response for the request; then the Call has no exact total. */
  usage?: Usage;
  /** How the provider served the Call, where the response says so (these change the price). */
  speed?: string;
  serviceTier?: string;
  inferenceGeo?: string;
  cost?: Cost;
  /**
   * The Calls of a Session that build on each other's context (one model, one purpose) form a lane; CallBlock runs
   * span the Calls of one lane.
   */
  lane: string;
  /** The number of Blocks in the input, once the request is split. */
  blockCount?: number;
  /** Positions of the Blocks that carry a cache breakpoint. */
  cacheBreakpoints: number[];
  /** The Cached prefix: the cache read in tokens, and the number of leading Blocks wholly inside it. */
  cacheBoundary?: { tokens: number; position: number };
  /**
   * Input tokens that belong to no Block: the end of the request after its last Block, known exactly when the last
   * Block carries the last cache breakpoint. The CallBlocks' tokens plus these add up to the input total.
   */
  framingTokens: number;
  /** What is wrong with this Call's data. Empty when its request is complete and its numbers reconcile. */
  issues: CallIssue[];
}

/**
 * A flag on a Call. `unresolved-request`: part of the request is not in the log, so the rebuilt input is
 * incomplete. `no-usage`: the log holds no Usage, so the Call has no exact total. `unreconciled-tokens`: the exact
 * change from the previous Call does not fit the new Blocks, so the whole total is split by estimate. `no-price`:
 * there is no list price for the model, so the Call has no cost. `price-assumption`: the cost rests on an
 * assumption that the log cannot confirm (a cache write's time to live, a long-context price). `estimate-clamped`: a
 * Block's share fell below its lower bound (its tool use id and structure) and was raised to it.
 */
export interface CallIssue {
  kind:
    | "unresolved-request"
    | "no-usage"
    | "unreconciled-tokens"
    | "no-price"
    | "price-assumption"
    | "estimate-clamped";
  detail: string;
}

/** A JSON value, as content is sent to the model provider. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** What a Block is, by its role in the request. */
export type BlockKind =
  | "tool-schema"
  | "system"
  | "user"
  | "reminder"
  | "assistant"
  | "reasoning"
  | "tool-call"
  | "tool-result"
  | "image"
  | "document"
  | "summary";

/** Where a Block's content came from, as far as the log tells. */
export interface BlockSource {
  /** The tool that the Block defines, calls, or holds the result of. */
  tool?: string;
  /** The file the tool read or wrote. */
  filePath?: string;
  /** The MCP server of the tool. */
  mcpServer?: string;
  /** The skill whose text or call this is. */
  skill?: string;
}

/** One unique piece of content sent to the model, identified by the hash of its content. */
export interface Block {
  hash: string;
  kind: BlockKind;
  source: BlockSource;
  /** Plain text for display: the text, or a short form of a tool call, tool schema, image or document. */
  text: string;
  /** The content as sent to the model provider (one content block, tool schema or system block). */
  content: JsonValue;
}

/** The part of a request a CallBlock is in. The provider reads the request in this order. */
export type RequestSection = "tools" | "system" | "messages";

/**
 * A run of one Block at one position over consecutive Calls of one lane, with the same tokens: one record while
 * the Block stays where it is. It appears in every Call of its Session and lane from `firstCall` to `lastCall`
 * (by `Call.index`); `lastCall` is absent while the run goes on to the lane's latest Call.
 */
export interface CallBlock {
  id: string;
  sessionId: string;
  lane: string;
  blockHash: string;
  /** 0-based position in each Call's input: tool schemas, then system blocks, then messages. */
  position: number;
  section: RequestSection;
  /** The index of the message that holds the Block, for the messages section. */
  message?: number;
  /** The Block's share of each Call's input total; absent for a Call with no Usage. */
  tokens?: number;
  basis?: TokenBasis;
  /** Blocks of one group were split from one exact total: their tokens add up to it. */
  group?: string;
  firstCall: number;
  lastCall?: number;
}

/** One use of a tool by the model. */
export interface ToolCall {
  /** The tool use id the model gave it. */
  id: string;
  sessionId: string;
  /** The Call whose response holds the tool use. */
  callId: string;
  name: string;
  input: JsonValue;
  source: BlockSource;
  /** The Block that holds the result, once a later Call sends it. */
  resultBlockHash?: string;
  isError: boolean;
  /** From the tool use to its result, by the log's timestamps. */
  durationMs?: number;
  /** The number of tool uses in the same response (1 when the tool ran alone). */
  parallel: number;
  /** The Session the tool started, for a tool that runs a subagent. */
  childSessionId?: string;
}

/** An event where the harness replaced most of a Session's context with a shorter summary. */
export interface Compaction {
  id: string;
  sessionId: string;
  ts: string;
  /** What started it, in the harness's words (for example `manual` or `auto`). */
  trigger: string;
  /** The context size before and after, as the harness reports it. */
  beforeTokens?: number;
  afterTokens?: number;
  /** The last Call before the compaction: its input is the context that was summarised. */
  beforeCallId?: string;
  /** The Call that wrote the summary; its usage is derived from running totals. */
  summaryCallId?: string;
}

/** Input that the adapter could not map, counted so that nothing is dropped in silence. */
export interface IngestReport {
  /** Unknown record kinds, by the harness's own name, with their counts, in the order first seen. */
  unknownRecords: { kind: string; count: number }[];
  /** Records that could not be read (bad JSON, missing fields): where (transcript and line) and why. */
  unreadable: { at: string; reason: string }[];
}

/**
 * What one read of new input added or changed: new and updated entities (each in full, by id), and the report's
 * new counts. Merging every delta in order gives the SessionGraph. `records` are the adapter's own data (in Claude
 * Code: messages, shapes, requests) that the caller keeps and gives back through a ContentLookup.
 */
export interface SessionDelta extends SessionGraph {
  records: AdapterRecord[];
}

/** A piece of an adapter's own data, by key. A later record with the same key replaces the earlier one. */
export interface AdapterRecord {
  key: string;
  value: JsonValue;
}

/**
 * What an adapter may ask its caller for, when its snapshot no longer holds it: what the caller kept from earlier
 * deltas. The store implements it in build step 5; each answer must reflect every delta applied so far.
 */
export interface ContentLookup {
  record(key: string): JsonValue | undefined;
  block(hash: string): Block | undefined;
  call(id: string): Call | undefined;
  toolCall(id: string): ToolCall | undefined;
  /** The runs of a lane that are still open (no `lastCall`): the input of the lane's latest split Call. */
  openRuns(sessionId: string, lane: string): CallBlock[];
}

/** Everything an adapter found in one Session and its subagent Sessions. */
export interface SessionGraph {
  sessions: Session[];
  calls: Call[];
  blocks: Block[];
  callBlocks: CallBlock[];
  toolCalls: ToolCall[];
  compactions: Compaction[];
  report: IngestReport;
}
