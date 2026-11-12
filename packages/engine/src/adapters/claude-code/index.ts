/** The Claude Code adapter: turn the JSONL transcripts of one session into the domain model. */
import type { Block, Call, IngestReport, SessionGraph } from "@quantext/shared";
import type { Estimator } from "../../core/estimate.ts";
import { attributeSession } from "./attribution.ts";
import { splitRequest } from "./blocks.ts";
import { callsOf } from "./calls.ts";
import type { SummaryCall } from "./compaction.ts";
import { compactionsOf } from "./compaction.ts";
import { obj, str } from "./json.ts";
import type { ContentNotes } from "./notes.ts";
import { contentNotes } from "./notes.ts";
import type { WireRequest } from "./rebuild.ts";
import { rebuildRequests } from "./rebuild.ts";
import type { Row } from "./rows.ts";
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
 * Parse one Claude Code session and its subagents into the domain model, with each Call's input split over its
 * Blocks. Input is text, not files: reading the files belongs to ingest. Unknown row types, unknown content blocks
 * and unreadable lines are counted in `report`, never dropped in silence.
 */
export function parseClaudeCodeSession(input: ClaudeCodeTranscripts, options: ParseOptions = {}): SessionGraph {
  const report: IngestReport = { unknownRecords: {}, unreadable: [] };
  const mainRows = readRows("main", input.main, report);
  const agents = input.subagents.map((agent, i) => ({
    rows: readRows(`subagent-${i}`, agent.text, report),
    meta: agent.meta,
  }));
  const allRows = [...mainRows, ...agents.flatMap((a) => a.rows)];
  const context: Context = {
    requests: rebuildRequests(allRows),
    notes: contentNotes(allRows),
    blocks: new Map(),
    report,
  };
  const mainId = sessionIdOf(mainRows) ?? "unknown";
  const graph = readSession(mainRows, mainId, context, options.estimator);
  for (const agent of agents) {
    const agentId = agentIdOf(agent.rows);
    const child = readSession(agent.rows, `${mainId}:agent-${agentId}`, context, options.estimator);
    for (const session of child.sessions) session.parentId = mainId;
    const toolUseId = str(obj(parseMeta(agent.meta))?.toolUseId) ?? agentToolUse(mainRows, agentId);
    const parent = graph.toolCalls.find((t) => t.id === toolUseId);
    if (parent !== undefined) parent.childSessionId = `${mainId}:agent-${agentId}`;
    graph.sessions.push(...child.sessions);
    graph.calls.push(...child.calls);
    graph.callBlocks.push(...child.callBlocks);
    graph.toolCalls.push(...child.toolCalls);
    graph.compactions.push(...child.compactions);
  }
  return { ...graph, blocks: [...context.blocks.values()], report };
}

interface Context {
  requests: ReadonlyMap<string, WireRequest>;
  notes: ContentNotes;
  /** Every Block of the session graph, by hash. */
  blocks: Map<string, Block>;
  report: IngestReport;
}

/** The Session, Calls, CallBlocks and ToolCalls of one transcript; new Blocks are added to `context.blocks`. */
function readSession(
  rows: readonly Row[],
  id: string,
  context: Context,
  estimator?: Estimator,
): Omit<SessionGraph, "blocks" | "report"> {
  const logged = callsOf(rows, id, context.requests);
  const { compactions, summaries } = compactionsOf(rows, id, logged, context.requests);
  const calls = inLogOrder(rows, logged, summaries);
  const summaryRequests = new Map(summaries.flatMap((s) => (s.request ? [[s.call.id, s.request] as const] : [])));
  const split = calls.map((call) => {
    const request = summaryRequests.get(call.id) ?? context.requests.get(call.id);
    const entries = request === undefined ? [] : splitRequest(request, context.notes);
    for (const { block, unknownType } of entries) {
      if (context.blocks.has(block.hash)) continue;
      context.blocks.set(block.hash, block);
      if (unknownType !== undefined) count(context.report, `content block ${unknownType}`);
    }
    return { call, request, entries };
  });
  const callBlocks = attributeSession(split, estimator);
  const toolCalls = toolCallsOf(rows, id, new Set(context.blocks.keys()));
  return { sessions: [sessionOf(rows, id)], calls, callBlocks, toolCalls, compactions };
}

/** Logged Calls and summarising Calls in the order of their rows, numbered from 0. */
function inLogOrder(rows: readonly Row[], logged: readonly Call[], summaries: readonly SummaryCall[]): Call[] {
  const at = new Map<string, number>();
  rows.forEach((row, i) => {
    if (row.type === "api-request") at.set(str(row.data.id) ?? row.at, i);
  });
  for (const summary of summaries) at.set(summary.call.id, summary.at);
  const calls = [...logged, ...summaries.map((s) => s.call)].sort((a, b) => (at.get(a.id) ?? 0) - (at.get(b.id) ?? 0));
  calls.forEach((call, index) => {
    call.index = index;
  });
  return calls;
}

function agentIdOf(rows: readonly Row[]): string {
  for (const row of rows) {
    const id = str(row.data.agentId);
    if (id !== undefined) return id;
  }
  return "unknown";
}

/** The tool use that started a subagent, from the agent id in the tool result of the parent transcript. */
function agentToolUse(rows: readonly Row[], agentId: string): string | undefined {
  for (const row of rows) {
    if (row.type !== "user" || str(obj(row.data.toolUseResult)?.agentId) !== agentId) continue;
    const content = obj(row.data.message)?.content;
    const first = Array.isArray(content) ? obj(content[0]) : undefined;
    return str(first?.tool_use_id);
  }
  return undefined;
}

function parseMeta(meta: string | undefined): unknown {
  if (meta === undefined) return undefined;
  try {
    return JSON.parse(meta);
  } catch {
    return undefined; // A broken meta file only loses the link; the agent id in the tool result still gives it.
  }
}

function count(report: IngestReport, kind: string): void {
  report.unknownRecords[kind] = (report.unknownRecords[kind] ?? 0) + 1;
}
