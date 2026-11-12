import { describe, expect, test } from "vitest";
import { parseClaudeCodeSession } from "../../../src/adapters/claude-code/index.ts";
import { mainRows, scenarios, transcriptsOf } from "../../fixtures.ts";
import { blocksAt, runsAt } from "./helpers.ts";

describe.each(scenarios())("rebuild of $version/$name", ({ name }) => {
  const graph = parseClaudeCodeSession(transcriptsOf(name));
  const logged = graph.calls.filter((call) => call.lane !== "compaction");
  const requests = new Map(
    mainRows(name).flatMap((row) => (row.type === "api-request" ? [[row.id as string, row]] : [])),
  );

  test("every logged Call resolves completely, and no logged Call has an issue", () => {
    expect(logged).toHaveLength(graph.calls.length - graph.compactions.length);
    expect(logged.filter((call) => call.issues.length > 0)).toEqual([]);
  });

  test.each(logged.map((call) => [call.id, call] as const))("call %s has keep + tail messages", (id, call) => {
    const runs = runsAt(graph, call);
    expect(runs).toHaveLength(call.blockCount ?? -1);
    const row = requests.get(id);
    if (row === undefined) return; // a subagent call: its rows are in the subagent transcript
    const messages = new Set(runs.flatMap((r) => (r.message === undefined ? [] : [r.message])));
    expect(messages.size).toBe((row.keep as number) + (row.tail as unknown[]).length);
  });
});

describe("rebuild of split and joined messages", () => {
  const typesOf = (scenario: string, index: number, message: number) => {
    const graph = parseClaudeCodeSession(transcriptsOf(scenario));
    const call = graph.calls[index];
    const byHash = new Map(graph.blocks.map((b) => [b.hash, b]));
    return runsAt(graph, call)
      .filter((r) => r.message === message)
      .map((r) => (byHash.get(r.blockHash)?.content as { type?: string } | undefined)?.type);
  };

  test("an assistant message written over several rows is one message with every block, in order", () => {
    // Call 6 follows call 5, whose response was three rows: thinking, text, tool use.
    expect(typesOf("basic-tools", 6, 13)).toEqual(["thinking", "text", "tool_use"]);
  });

  test("a Skill tool result and the skill text after it are one user message", () => {
    expect(typesOf("resume", 3, 8)).toEqual(["tool_result", "text"]);
  });

  test("a string prompt is one text block", () => {
    expect(typesOf("resume", 0, 0)).toEqual(["text"]);
  });
});

describe("rebuild with a part missing from the log", () => {
  test("flags the Call with the hash of a message that is not in the log", () => {
    const { main } = transcriptsOf("basic-tools");
    const blob = "57f8db8649716b6b1a1f14bfb320331edaae432d80df2b5b26ed801af4679fa3";
    const without = main
      .split("\n")
      .filter((line) => !line.includes(`"type":"api-request-blob"`) || !line.includes(blob))
      .join("\n");
    const graph = parseClaudeCodeSession({ main: without, subagents: [] });
    expect(graph.calls[7]?.issues).toEqual([
      { kind: "unresolved-request", detail: `message ${blob} is not in the log` },
    ]);
    expect(graph.calls[6]?.issues).toEqual([]);
    expect(blocksAt(graph, graph.calls[7])).toEqual([]);
  });

  test("resolves a request whose base is an earlier call than the one before", () => {
    const { main } = transcriptsOf("basic-tools");
    const rows = main
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const requests = rows.filter((r) => r.type === "api-request");
    const base = requests[3] as Record<string, unknown>;
    const fork = { ...base, id: "fork", base: base.id, keep: 4, tail: [], timestamp: "2026-11-12T00:27:00.000Z" };
    const reply = rows.find((r) => r.type === "assistant") as Record<string, unknown>;
    const answer = { ...reply, requestRef: "fork", message: { ...(reply.message as object), id: "msg_fork" } };
    const graph = parseClaudeCodeSession({
      main: `${main}${JSON.stringify(fork)}\n${JSON.stringify(answer)}\n`,
      subagents: [],
    });
    const call = graph.calls.find((c) => c.id === "fork");
    expect(call?.issues.filter((i) => i.kind === "unresolved-request")).toEqual([]);
    const forkBlocks = blocksAt(graph, call).map((b) => b.hash);
    expect(forkBlocks).toEqual(
      blocksAt(graph, graph.calls[3])
        .slice(0, forkBlocks.length)
        .map((b) => b.hash),
    );
    expect(
      new Set(
        runsAt(graph, call)
          .map((r) => r.message)
          .filter((m) => m !== undefined),
      ).size,
    ).toBe(4);
  });
});
