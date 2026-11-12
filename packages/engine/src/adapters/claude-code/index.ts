/** The Claude Code adapter: turn the JSONL transcripts of one session into the domain model. */
import type { IngestReport, SessionGraph } from "@quantext/shared";
import { callsOf } from "./calls.ts";
import { readRows } from "./rows.ts";
import { sessionIdOf, sessionOf } from "./session.ts";

/** One session's transcripts as text: the main transcript and each subagent transcript (with its meta file). */
export interface ClaudeCodeTranscripts {
  main: string;
  subagents: readonly { text: string; meta?: string }[];
}

/**
 * Parse one Claude Code session into Sessions and Calls. Input is text, not files: reading the files belongs to
 * ingest. Unknown row types and unreadable lines are counted in `report`, never dropped in silence.
 */
export function parseClaudeCodeSession(input: ClaudeCodeTranscripts): SessionGraph {
  const report: IngestReport = { unknownRecords: {}, unreadable: [] };
  const rows = readRows("main", input.main, report);
  const id = sessionIdOf(rows) ?? "unknown";
  return { sessions: [sessionOf(rows, id)], calls: callsOf(rows, id), report };
}
