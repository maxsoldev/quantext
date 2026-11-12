/** The Claude Code adapter: turn the JSONL transcripts of one session into the domain model. */
import type { SessionGraph } from "@quantext/shared";
import { emptyGraph, mergeDelta } from "../../core/graph.ts";
import type { ParseOptions } from "./parser.ts";
import { createClaudeCodeParser } from "./parser.ts";

export type { ClaudeCodeParser, ParseOptions } from "./parser.ts";
export { createClaudeCodeParser } from "./parser.ts";
export type { ParserState } from "./state.ts";
export { ADAPTER_VERSION, claudeCodeCodec } from "./stored.ts";

/** One session's transcripts as text: the main transcript and each subagent transcript (with its meta file). */
export interface ClaudeCodeTranscripts {
  main: string;
  subagents: readonly { text: string; meta?: string }[];
}

/**
 * Parse one whole Claude Code session and its subagents into the domain model: one push per transcript into the
 * incremental parser, with every delta merged. Input is text, not files: reading files belongs to ingest.
 */
export function parseClaudeCodeSession(input: ClaudeCodeTranscripts, options: ParseOptions = {}): SessionGraph {
  const parser = createClaudeCodeParser(undefined, options);
  let graph = mergeDelta(emptyGraph(), parser.push(input.main));
  graph = mergeDelta(graph, parser.flush());
  input.subagents.forEach((agent, i) => {
    const name = `subagent-${i}`;
    if (agent.meta !== undefined) graph = mergeDelta(graph, parser.pushMeta(name, agent.meta));
    graph = mergeDelta(graph, parser.push(agent.text, name));
    graph = mergeDelta(graph, parser.flush(name));
  });
  return graph;
}
