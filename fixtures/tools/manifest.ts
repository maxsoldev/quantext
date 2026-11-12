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
