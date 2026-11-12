/** Helpers to compare stored graphs: a fixed order, and deltas of one read of a scenario. */
import type { SessionDelta, SessionGraph } from "@quantext/shared";
import type { ClaudeCodeTranscripts } from "../../src/adapters/claude-code/index.ts";
import { createClaudeCodeParser } from "../../src/adapters/claude-code/index.ts";

/** The graph in a fixed order, so that two ways of reading can be compared. */
export function normal(graph: SessionGraph): SessionGraph {
  const by =
    <T>(key: (x: T) => string) =>
    (a: T, b: T) =>
      key(a).localeCompare(key(b));
  return {
    sessions: [...graph.sessions].sort(by((s) => s.id)),
    calls: [...graph.calls].sort(by((c) => c.id)),
    blocks: [...graph.blocks].sort(by((b) => b.hash)),
    callBlocks: [...graph.callBlocks].sort(by((r) => r.id)),
    toolCalls: [...graph.toolCalls].sort(by((t) => t.id)),
    compactions: [...graph.compactions].sort(by((c) => c.id)),
    events: [...graph.events].sort(by((e) => e.id)),
    report: graph.report,
  };
}

/** A small deterministic random number generator, so a failing case can be found again. */
export function random(seed: number): () => number {
  let x = seed;
  return () => {
    x = (x * 1103515245 + 12345) % 2147483648;
    return x / 2147483648;
  };
}

/** Cut a text into pieces of random length, many of them inside a line. */
export function chunks(text: string, next: () => number): string[] {
  const out: string[] = [];
  for (let at = 0; at < text.length; ) {
    const size = 1 + Math.floor(next() * (next() < 0.5 ? 40 : 4000));
    out.push(text.slice(at, at + size));
    at += size;
  }
  return out;
}

/** The deltas of one whole read: the main transcript, then each subagent with its meta file. */
export function deltasOf(input: ClaudeCodeTranscripts): SessionDelta[] {
  const parser = createClaudeCodeParser();
  const out = [parser.push(input.main), parser.flush()];
  input.subagents.forEach((agent, i) => {
    if (agent.meta !== undefined) out.push(parser.pushMeta(`subagent-${i}`, agent.meta));
    out.push(parser.push(agent.text, `subagent-${i}`), parser.flush(`subagent-${i}`));
  });
  return out;
}
