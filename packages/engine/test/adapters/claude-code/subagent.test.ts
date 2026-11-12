import { describe, expect, test } from "vitest";
import { parseClaudeCodeSession } from "../../../src/adapters/claude-code/index.ts";
import { transcriptsOf } from "../../fixtures.ts";

const PARENT = "00000000-0000-4000-8000-000000000002";
const CHILD = `${PARENT}:agent-a326b693f67d5a3e8`;

describe("a subagent", () => {
  const graph = parseClaudeCodeSession(transcriptsOf("subagent"));

  test("is its own Session, with the main Session as its parent", () => {
    expect(graph.sessions.map((s) => [s.id, s.parentId])).toEqual([
      [PARENT, undefined],
      [CHILD, PARENT],
    ]);
    expect(graph.sessions[1]).toMatchObject({ harness: "claude-code", harnessVersion: "2.1.322" });
  });

  test("has its own Calls, numbered from 0, with exact usage", () => {
    const calls = graph.calls.filter((c) => c.sessionId === CHILD);
    expect(calls.map((c) => c.index)).toEqual([0, 1, 2]);
    expect(calls.map((c) => c.usage?.outputTokens)).toEqual([141, 75, 82]);
  });

  test("is linked from the parent's Agent tool call", () => {
    const agent = graph.toolCalls.find((t) => t.name === "Agent");
    expect(agent).toMatchObject({ sessionId: PARENT, childSessionId: CHILD });
  });

  test("has its own tool calls", () => {
    expect(graph.toolCalls.filter((t) => t.sessionId === CHILD).map((t) => t.name)).toEqual(["Bash", "Read"]);
  });

  test("is linked by the agent id in the tool result when there is no meta file", () => {
    const { main, subagents } = transcriptsOf("subagent");
    const without = parseClaudeCodeSession({ main, subagents: subagents.map(({ text }) => ({ text })) });
    expect(without.toolCalls.find((t) => t.name === "Agent")?.childSessionId).toBe(CHILD);
  });
});
