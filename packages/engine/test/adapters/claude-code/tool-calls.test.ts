import { describe, expect, test } from "vitest";
import { parseClaudeCodeSession } from "../../../src/adapters/claude-code/index.ts";
import { transcriptsOf } from "../../fixtures.ts";

const REPO = "/fixture-0000000000000000/repo";

describe("tool calls of basic-tools", () => {
  const graph = parseClaudeCodeSession(transcriptsOf("basic-tools"));
  const blocks = new Map(graph.blocks.map((b) => [b.hash, b]));

  test("lists every tool use in order, with the Call whose response holds it", () => {
    expect(graph.toolCalls.map((t) => t.name)).toEqual([
      "Bash",
      "Bash",
      "Read",
      "Read",
      "Bash",
      "Read",
      "Edit",
      "Read",
      "Read",
    ]);
    expect(graph.toolCalls[0]).toMatchObject({
      id: "toolu_bdrk_012kXteQTdXHqEsfLRyPHRXm",
      callId: graph.calls[0]?.id,
      sessionId: graph.sessions[0]?.id,
      input: { command: "find src -name '*.ts'", description: "Find TypeScript files in src" },
      isError: false,
      parallel: 1,
    });
  });

  test("links each tool call to the Block that holds its result", () => {
    for (const toolCall of graph.toolCalls) {
      const result = blocks.get(toolCall.resultBlockHash ?? "");
      expect(result?.kind).toBe("tool-result");
      expect(result?.content).toMatchObject({ tool_use_id: toolCall.id });
    }
  });

  test("marks a failed tool call as an error", () => {
    const missing = graph.toolCalls.filter((t) => t.isError);
    expect(missing.map((t) => t.source)).toEqual([{ tool: "Read", filePath: `${REPO}/missing.txt` }]);
  });

  test("counts tool calls made in one response as parallel", () => {
    expect(graph.toolCalls.map((t) => t.parallel)).toEqual([1, 1, 1, 1, 1, 1, 3, 3, 3]);
  });

  test("measures how long each tool ran, from the tool use to its result in the log", () => {
    const first = graph.toolCalls[0];
    // The tool use row is at 00:26:05.391Z, the tool result row at 00:26:05.446Z.
    expect(first?.durationMs).toBe(55);
    expect(graph.toolCalls.every((t) => (t.durationMs ?? -1) >= 0)).toBe(true);
  });
});

test("an MCP tool call names its server", () => {
  const graph = parseClaudeCodeSession(transcriptsOf("mcp-deferred"));
  expect(graph.toolCalls.map((t) => [t.name, t.source])).toEqual([
    ["ToolSearch", { tool: "ToolSearch" }],
    ["mcp__dictionary__lookup_word", { tool: "mcp__dictionary__lookup_word", mcpServer: "dictionary" }],
  ]);
});
