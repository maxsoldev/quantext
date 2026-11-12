import type { Block, SessionGraph } from "@quantext/shared";
import { describe, expect, test } from "vitest";
import { parseClaudeCodeSession } from "../../../src/adapters/claude-code/index.ts";
import { scenarios, transcriptsOf } from "../../fixtures.ts";

const REPO = "/fixture-0000000000000000/repo";

function blocksOfCall(graph: SessionGraph, index: number): Block[] {
  const call = graph.calls[index];
  const byHash = new Map(graph.blocks.map((block) => [block.hash, block]));
  return graph.callBlocks
    .filter((cb) => cb.callId === call?.id)
    .sort((a, b) => a.position - b.position)
    .flatMap((cb) => byHash.get(cb.blockHash) ?? []);
}

describe.each(scenarios())("blocks of $version/$name", ({ name }) => {
  const graph = parseClaudeCodeSession(transcriptsOf(name));

  test("each Block appears once, and every CallBlock names a Block", () => {
    const hashes = graph.blocks.map((block) => block.hash);
    expect(new Set(hashes).size).toBe(hashes.length);
    const known = new Set(hashes);
    expect(graph.callBlocks.filter((cb) => !known.has(cb.blockHash))).toEqual([]);
  });

  test("each Call's CallBlocks have the positions 0..n-1, tool schemas first, then system, then messages", () => {
    for (const call of graph.calls) {
      const own = graph.callBlocks.filter((cb) => cb.callId === call.id).sort((a, b) => a.position - b.position);
      expect(own.map((cb) => cb.position)).toEqual(own.map((_, i) => i));
      const order = { tools: 0, system: 1, messages: 2 };
      const sections = own.map((cb) => order[cb.section]);
      expect(sections).toEqual([...sections].sort((a, b) => a - b));
    }
  });

  test("no content block type is unknown", () => {
    expect(graph.report.unknownRecords).toEqual({});
  });
});

describe("block kinds and sources", () => {
  const basic = parseClaudeCodeSession(transcriptsOf("basic-tools"));
  const last = blocksOfCall(basic, 7);

  test("the request of the first call is the tool schemas, the system blocks and the first messages", () => {
    const first = blocksOfCall(basic, 0);
    expect(first.map((b) => b.kind)).toEqual([
      ...Array(12).fill("tool-schema"),
      "system",
      "system",
      "reminder",
      "user",
      "system",
    ]);
    expect(first[1]?.source).toEqual({ tool: "Bash" });
  });

  test("a tool result names its tool and the file it read", () => {
    const big = last.find((b) => b.kind === "tool-result" && b.source.filePath === `${REPO}/src/big.txt`);
    expect(big?.source).toEqual({ tool: "Read", filePath: `${REPO}/src/big.txt` });
    const calls = last.filter((b) => b.kind === "tool-call").map((b) => b.source.tool);
    expect(calls).toEqual(["Bash", "Bash", "Read", "Read", "Bash", "Read", "Edit", "Read", "Read"]);
  });

  test("reasoning blocks are their own kind", () => {
    expect(last.filter((b) => b.kind === "reasoning")).toHaveLength(1);
  });

  test("one content in many Calls is one Block", () => {
    const system = blocksOfCall(basic, 0)[12];
    expect(basic.callBlocks.filter((cb) => cb.blockHash === system?.hash)).toHaveLength(8);
  });

  test("cache breakpoints are marked on the blocks that carry them", () => {
    const first = basic.callBlocks.filter((cb) => cb.callId === basic.calls[0]?.id && cb.cacheBreakpoint);
    expect(first.map((cb) => [cb.section, cb.message, cb.position])).toEqual([
      ["system", undefined, 12],
      ["system", undefined, 13],
      ["messages", 1, 16],
    ]);
  });

  test("an MCP tool schema and its result name the MCP server", () => {
    const mcp = parseClaudeCodeSession(transcriptsOf("mcp-deferred"));
    const blocks = blocksOfCall(mcp, 2);
    const tool = "mcp__dictionary__lookup_word";
    expect(blocks.find((b) => b.kind === "tool-schema" && b.source.tool === tool)?.source).toEqual({
      tool,
      mcpServer: "dictionary",
    });
    expect(blocks.find((b) => b.kind === "tool-result" && b.source.tool === tool)?.source).toEqual({
      tool,
      mcpServer: "dictionary",
    });
  });

  test("a skill's text is a reminder from the skill; an @file is a reminder from the Read tool", () => {
    const resume = parseClaudeCodeSession(transcriptsOf("resume"));
    const blocks = blocksOfCall(resume, 3);
    expect(blocks.filter((b) => b.source.skill !== undefined).map((b) => [b.kind, b.source])).toEqual([
      ["tool-call", { tool: "Skill", skill: "keybindings-help" }],
      ["tool-result", { tool: "Skill", skill: "keybindings-help" }],
      ["reminder", { tool: "Skill", skill: "keybindings-help" }],
    ]);
    const file = { tool: "Read", filePath: `${REPO}/notes.txt` };
    expect(blocks.filter((b) => b.kind === "reminder" && b.source.filePath !== undefined).map((b) => b.source)).toEqual(
      [file, file],
    );
  });

  test("a compaction summary is a summary block", () => {
    const compaction = parseClaudeCodeSession(transcriptsOf("compaction"));
    const after = blocksOfCall(compaction, 4);
    expect(after.filter((b) => b.kind === "summary")).toHaveLength(1);
  });

  test("a Read of an image is a tool result that holds the image", () => {
    const image = parseClaudeCodeSession(transcriptsOf("image"));
    const result = blocksOfCall(image, 1).find((b) => b.kind === "tool-result");
    expect(result?.source).toEqual({ tool: "Read", filePath: `${REPO}/diagram.png` });
    expect(JSON.stringify(result?.content)).toContain('"type":"image"');
  });
});

describe("content blocks the adapter does not know", () => {
  test("are counted once per Block in the report and kept as blocks of their role", () => {
    const { main } = transcriptsOf("basic-tools");
    const odd = main.replace(
      '"role":"system","content":[{"type":"text"',
      '"role":"system","content":[{"type":"brand_new"',
    );
    const graph = parseClaudeCodeSession({ main: odd, subagents: [] });
    expect(graph.report.unknownRecords).toEqual({ "content block brand_new": 1 });
    expect(blocksOfCall(graph, 0)[16]?.kind).toBe("system");
  });
});
