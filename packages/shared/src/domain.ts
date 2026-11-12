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
  report: IngestReport;
}
