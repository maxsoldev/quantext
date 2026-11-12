/** The per-scenario `manifest.json`: what a fixture holds, so a later edit to a transcript is caught by tests. */

export interface TranscriptSummary {
  rows: number;
  /** One per LLM call: the `api-request` rows. */
  llmCalls: number;
  /** Row count per `type`, keys sorted. */
  rowTypes: Record<string, number>;
}

export interface Manifest {
  scenario: string;
  harness: "claude-code";
  harnessVersion: string;
  description: string;
  exercises: string[];
  /** The `claude` command lines that made the session, with the prompts. */
  steps: string[];
  /** Sum of `total_cost_usd` from `claude -p --output-format json`, at recording time. */
  costUsd: number;
  /** Tail hashes that match no blob, user or assistant row (see normalise.ts). */
  unresolvedTailHashes: number;
  /** Paths relative to the scenario folder: the main transcript first, then subagent files. */
  transcripts: Record<string, TranscriptSummary>;
  /** Compactions per transcript, with the derived usage of the summarising call (see compactionsOf). */
  compactions: Record<string, CompactionSummary[]>;
}

/** Count the rows of one JSONL transcript by type. Throws with `file:line` on a row that is not JSON. */
export function summariseTranscript(file: string, text: string): TranscriptSummary {
  const counts = new Map<string, number>();
  let rows = 0;
  for (const [index, line] of text.split("\n").entries()) {
    if (line.trim() === "") continue;
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch (error) {
      throw new Error(`${file}:${index + 1}: not JSON (${(error as Error).message})`);
    }
    const type = typeof row === "object" && row !== null && "type" in row ? String(row.type) : "(none)";
    counts.set(type, (counts.get(type) ?? 0) + 1);
    rows++;
  }
  const rowTypes = Object.fromEntries([...counts].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return { rows, llmCalls: counts.get("api-request") ?? 0, rowTypes };
}

type TokenCounts = Record<(typeof TOKEN_FIELDS)[number], number>;
const TOKEN_FIELDS = ["inputTokens", "outputTokens", "cacheReadInputTokens", "cacheCreationInputTokens"] as const;
const USAGE_FIELDS: Record<(typeof TOKEN_FIELDS)[number], string> = {
  inputTokens: "input_tokens",
  outputTokens: "output_tokens",
  cacheReadInputTokens: "cache_read_input_tokens",
  cacheCreationInputTokens: "cache_creation_input_tokens",
};

export interface CompactionSummary {
  /** Line of the `compact_boundary` row. */
  line: number;
  trigger: string | null;
  preTokens: number | null;
  postTokens: number | null;
  /** Always "derived": the summarising call has no row of its own, so its usage is not exact. */
  basis: "derived";
  /** Per model; null when a cost-state row before or after the boundary is missing. */
  summaryUsage: Record<string, TokenCounts> | null;
}

/**
 * Each compaction of a transcript, with the summarising call's usage derived as the change of the cumulative
 * `cost-state.modelUsage` from the last row before the boundary to the first after it, minus the usage of the
 * calls logged in between (each assistant message once, by `message.id`).
 */
export function compactionsOf(text: string): CompactionSummary[] {
  // biome-ignore lint/suspicious/noExplicitAny: transcript rows are untyped JSON
  const rows: { line: number; row: any }[] = text
    .split("\n")
    .map((line, index) => ({ line: index + 1, text: line }))
    .filter(({ text: line }) => line.trim() !== "")
    .map(({ line, text: json }) => ({ line, row: JSON.parse(json) }));
  const result: CompactionSummary[] = [];
  for (const [at, { line, row }] of rows.entries()) {
    if (row.type !== "system" || row.subtype !== "compact_boundary") continue;
    const meta = row.compactMetadata ?? {};
    const before = rows.slice(0, at).findLast(({ row: r }) => r.type === "cost-state");
    const afterAt = rows.findIndex(({ row: r }, i) => i > at && r.type === "cost-state");
    let summaryUsage: Record<string, TokenCounts> | null = null;
    if (before !== undefined && afterAt !== -1) {
      const after = rows[afterAt]?.row.modelUsage ?? {};
      summaryUsage = {};
      for (const [model, counts] of Object.entries<Record<string, number>>(after)) {
        const previous = before.row.modelUsage?.[model] ?? {};
        summaryUsage[model] = Object.fromEntries(
          TOKEN_FIELDS.map((field) => [field, (counts[field] ?? 0) - (previous[field] ?? 0)]),
        ) as TokenCounts;
      }
      const seen = new Set<string>();
      for (const { row: r } of rows.slice(at + 1, afterAt)) {
        if (r.type !== "assistant" || seen.has(r.message?.id)) continue;
        seen.add(r.message?.id);
        const counts = summaryUsage[r.requestedModel ?? r.message?.model];
        if (counts === undefined) continue; // a model without a cost-state entry: nothing to subtract from
        for (const field of TOKEN_FIELDS) counts[field] -= r.message?.usage?.[USAGE_FIELDS[field]] ?? 0;
      }
    }
    result.push({
      line,
      trigger: meta.trigger ?? null,
      preTokens: meta.preTokens ?? null,
      postTokens: meta.postTokens ?? null,
      basis: "derived",
      summaryUsage,
    });
  }
  return result;
}
