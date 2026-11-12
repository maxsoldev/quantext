/** The Claude Code adapter: turn the JSONL transcripts of one session into the domain model. */
import type { Block, IngestReport, SessionGraph } from "@quantext/shared";
import type { Estimator } from "../../core/estimate.ts";
import { attributeSession } from "./attribution.ts";
import { splitRequest } from "./blocks.ts";
import { callsOf } from "./calls.ts";
import { contentNotes } from "./notes.ts";
import { rebuildRequests } from "./rebuild.ts";
import { readRows } from "./rows.ts";
import { sessionIdOf, sessionOf } from "./session.ts";
import { toolCallsOf } from "./tool-calls.ts";

/** One session's transcripts as text: the main transcript and each subagent transcript (with its meta file). */
export interface ClaudeCodeTranscripts {
  main: string;
  subagents: readonly { text: string; meta?: string }[];
}

export interface ParseOptions {
  /** Splits a total over several new Blocks; the default estimates by characters and image size. */
  estimator?: Estimator;
}

/**
 * Parse one Claude Code session into the domain model, with each Call's input split over its Blocks. Input is
 * text, not files: reading the files belongs to ingest. Unknown row types, unknown content blocks and unreadable
 * lines are counted in `report`, never dropped in silence.
 */
export function parseClaudeCodeSession(input: ClaudeCodeTranscripts, options: ParseOptions = {}): SessionGraph {
  const report: IngestReport = { unknownRecords: {}, unreadable: [] };
  const rows = readRows("main", input.main, report);
  const agentRows = input.subagents.map((agent, i) => readRows(`subagent-${i}`, agent.text, report));
  const allRows = [...rows, ...agentRows.flat()];
  const requests = rebuildRequests(allRows);
  const notes = contentNotes(allRows);
  const id = sessionIdOf(rows) ?? "unknown";
  const calls = callsOf(rows, id, requests);

  const blocks = new Map<string, Block>();
  const split = calls.map((call) => {
    const request = requests.get(call.id);
    const entries = request === undefined ? [] : splitRequest(request, notes);
    for (const { block, unknownType } of entries) {
      if (blocks.has(block.hash)) continue;
      blocks.set(block.hash, block);
      if (unknownType !== undefined) count(report, `content block ${unknownType}`);
    }
    return { call, request, entries };
  });
  const callBlocks = attributeSession(split, options.estimator);
  const toolCalls = toolCallsOf(rows, id, new Set(blocks.keys()));
  return { sessions: [sessionOf(rows, id)], calls, blocks: [...blocks.values()], callBlocks, toolCalls, report };
}

function count(report: IngestReport, kind: string): void {
  report.unknownRecords[kind] = (report.unknownRecords[kind] ?? 0) + 1;
}
