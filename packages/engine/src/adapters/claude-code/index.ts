/** The Claude Code adapter: turn the JSONL transcripts of one session into the domain model. */
import type { Block, CallBlock, IngestReport, SessionGraph } from "@quantext/shared";
import { splitRequest } from "./blocks.ts";
import { callsOf } from "./calls.ts";
import { contentNotes } from "./notes.ts";
import { rebuildRequests } from "./rebuild.ts";
import { readRows } from "./rows.ts";
import { sessionIdOf, sessionOf } from "./session.ts";

/** One session's transcripts as text: the main transcript and each subagent transcript (with its meta file). */
export interface ClaudeCodeTranscripts {
  main: string;
  subagents: readonly { text: string; meta?: string }[];
}

/**
 * Parse one Claude Code session into the domain model. Input is text, not files: reading the files belongs to
 * ingest. Unknown row types, unknown content blocks and unreadable lines are counted in `report`, never dropped
 * in silence.
 */
export function parseClaudeCodeSession(input: ClaudeCodeTranscripts): SessionGraph {
  const report: IngestReport = { unknownRecords: {}, unreadable: [] };
  const rows = readRows("main", input.main, report);
  const agentRows = input.subagents.map((agent, i) => readRows(`subagent-${i}`, agent.text, report));
  const allRows = [...rows, ...agentRows.flat()];
  const requests = rebuildRequests(allRows);
  const notes = contentNotes(allRows);
  const id = sessionIdOf(rows) ?? "unknown";
  const calls = callsOf(rows, id, requests);

  const blocks = new Map<string, Block>();
  const callBlocks: CallBlock[] = [];
  for (const call of calls) {
    const request = requests.get(call.id);
    if (request === undefined) continue;
    splitRequest(request, notes).forEach((entry, position) => {
      if (!blocks.has(entry.block.hash)) {
        blocks.set(entry.block.hash, entry.block);
        if (entry.unknownType !== undefined) count(report, `content block ${entry.unknownType}`);
      }
      const callBlock: CallBlock = {
        callId: call.id,
        blockHash: entry.block.hash,
        position,
        section: entry.section,
        cacheBreakpoint: entry.cacheBreakpoint,
      };
      if (entry.message !== undefined) callBlock.message = entry.message;
      callBlocks.push(callBlock);
    });
  }
  return { sessions: [sessionOf(rows, id)], calls, blocks: [...blocks.values()], callBlocks, report };
}

function count(report: IngestReport, kind: string): void {
  report.unknownRecords[kind] = (report.unknownRecords[kind] ?? 0) + 1;
}
