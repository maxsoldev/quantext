/**
 * The harness-neutral domain model (docs/ARCHITECTURE.md, docs/GLOSSARY.md). Adapters produce it, every layer
 * above reads it. No harness row names or shapes appear here.
 */

/**
 * How a token number was found. `exact`: reported by the model provider for this Call. `derived`: computed from
 * exact counters (for example the change of a cumulative total). `estimate`: from an estimator, used only to split
 * an exact or derived total.
 */
export type TokenBasis = "exact" | "derived" | "estimate";

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

/** The parameters of a Call that are not part of its Shape. */
export interface CallParams {
  maxTokens?: number;
  thinking?: { type: string; budgetTokens?: number };
  effort?: string;
  betas: string[];
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
  cost?: Cost;
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
 * there is no list price for the model, so the Call has no cost.
 */
export interface CallIssue {
  kind: "unresolved-request" | "no-usage" | "unreconciled-tokens" | "no-price";
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
  /** The content as sent to the model provider (one content block, tool schema or system block). */
  content: JsonValue;
}

/** The part of a request a CallBlock is in. The provider reads the request in this order. */
export type RequestSection = "tools" | "system" | "messages";

/** One appearance of a Block in a Call's input. */
export interface CallBlock {
  callId: string;
  blockHash: string;
  /** 0-based position in the Call's input: tool schemas, then system blocks, then messages. */
  position: number;
  section: RequestSection;
  /** The index of the message that holds the Block, for the messages section. */
  message?: number;
  /** The Block carries a cache breakpoint. */
  cacheBreakpoint: boolean;
  /** The Block's share of the Call's input total; absent when the Call has no Usage. */
  tokens?: number;
  basis?: TokenBasis;
  /** Inside the Cached prefix: the part of the input the provider read from its cache. */
  inCachedPrefix: boolean;
  /** The Block's share of the Call's input cost in US dollars, by the cache part its tokens are in. */
  costUsd?: number;
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
  /** The Call that wrote the summary, when its usage could be derived. */
  summaryCallId?: string;
}

/** Input that the adapter could not map, counted so that nothing is dropped in silence. */
export interface IngestReport {
  /** Unknown record kinds, by the harness's own name, with their counts. */
  unknownRecords: Record<string, number>;
  /** Records that could not be read (bad JSON, missing fields): where (transcript and line) and why. */
  unreadable: { at: string; reason: string }[];
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
