import type { CallContext, ContextBlock } from "@quantext/shared";
import { describe, expect, test } from "vitest";
import { blockSource, hiddenPart, listRows, sourceLabel } from "./model.ts";

const block = (position: number, section: ContextBlock["section"], tokens: number, extra: Partial<ContextBlock> = {}) =>
  ({
    position,
    section,
    kind: section === "tools" ? "tool-schema" : section === "system" ? "system" : "user",
    category: "user",
    source: {},
    tokens,
    basis: "estimate",
    inCachedPrefix: true,
    preview: "",
    chars: 0,
    truncated: false,
    ...extra,
  }) as ContextBlock;

const ctx = (blocks: ContextBlock[]): CallContext =>
  ({
    blocks,
    sections: { tools: 30, system: 20, messages: 45, framing: 5 },
    totalTokens: 100,
  }) as CallContext;

describe("the rows of a Call's block list", () => {
  test("a header before each section that has blocks, in request order, then its blocks", () => {
    const c = ctx([block(0, "tools", 30), block(1, "system", 20), block(2, "messages", 45), block(3, "framing", 5)]);
    expect(listRows(c).map((r) => (r.type === "section" ? `# ${r.section} ${r.tokens}` : r.block.position))).toEqual([
      "# tools 30",
      0,
      "# system 20",
      1,
      "# messages 45",
      2,
      3,
    ]);
  });
});

describe("the parts of a block", () => {
  const part = (label: string, tokens: number, preview = "") => ({
    label,
    source: { attachment: label.toLowerCase() },
    start: 0,
    end: 1,
    tokens,
    basis: "estimate" as const,
    preview,
    chars: 1,
    truncated: false,
  });
  const merged = block(2, "messages", 45, {
    kind: "system",
    preview: "# Environment",
    parts: [part("Environment", 15), part("Skill listing", 30, "The following skills are available")],
  });
  const rowsOf = (c: CallContext, find?: string) =>
    listRows(c, find).map((r) =>
      r.type === "section" ? `# ${r.section}` : r.type === "part" ? `  ${r.part.label}` : r.block.position,
    );

  test("follow their block as rows of their own, when it has more than one", () => {
    const single = block(3, "messages", 0, { parts: [part("Date", 0)] });
    expect(rowsOf(ctx([block(0, "tools", 30), merged, single]))).toEqual([
      "# tools",
      0,
      "# messages",
      2,
      "  Environment",
      "  Skill listing",
      3,
    ]);
  });

  test("a search keeps the blocks whose kind, source, preview or part matches, with only the parts that match", () => {
    const read = block(4, "messages", 0, { kind: "tool-result", source: { tool: "Read", filePath: "skills.md" } });
    const c = ctx([block(0, "tools", 30, { preview: "Bash" }), merged, read]);
    expect(rowsOf(c, "SKILL")).toEqual(["# messages", 2, "  Skill listing", 4]);
    expect(rowsOf(c, "environment")).toEqual(["# messages", 2, "  Environment"]);
    expect(rowsOf(c, "tool schema")).toEqual(["# tools", 0]);
    expect(rowsOf(c, "nothing like it")).toEqual([]);
  });

  test("a block that one attached text is all of is named by its part, one with several by their number", () => {
    expect(blockSource(merged)).toBe("2 attached texts");
    expect(blockSource(block(3, "messages", 0, { source: { attachment: "date" }, parts: [part("Date", 0)] }))).toBe(
      "Date",
    );
    expect(blockSource(block(3, "messages", 0, { source: { tool: "Read", filePath: "a", attachment: "file" } }))).toBe(
      "Read a",
    );
  });
});

describe("the hidden part", () => {
  test("tool schemas and the system prompt: what the model gets before the first message", () => {
    expect(hiddenPart(ctx([]))).toEqual({ tools: 30, system: 20, tokens: 50, share: 0.5 });
  });
});

describe("where a block came from", () => {
  test("names the tool, file, MCP server, skill or attachment, most specific first", () => {
    expect(sourceLabel({ tool: "Read", filePath: "src/a.ts" })).toBe("Read src/a.ts");
    expect(sourceLabel({ tool: "mcp__dictionary__lookup_word", mcpServer: "dictionary" })).toBe(
      "MCP dictionary: lookup_word",
    );
    expect(sourceLabel({ skill: "tdd" })).toBe("Skill tdd");
    expect(sourceLabel({ attachment: "session context" })).toBe("session context");
    expect(sourceLabel({ tool: "Bash" })).toBe("Bash");
    expect(sourceLabel({})).toBe("");
  });
});

describe("the context bar's segments", () => {
  test("one segment per block that has room, placed by token offset in percent", async () => {
    const { barSegments } = await import("./model.ts");
    const blocks = [
      block(0, "tools", 50, { category: "tool-definitions" }),
      block(1, "messages", 50, { category: "user" }),
    ];
    expect(barSegments(blocks, 100).map((s) => [s.left, s.width, s.category, s.blocks.length])).toEqual([
      [0, 50, "tool-definitions", 1],
      [50, 50, "user", 1],
    ]);
  });

  test("runs of tiny blocks of one category merge into one segment; empty blocks draw nothing", async () => {
    const { barSegments } = await import("./model.ts");
    const blocks = [
      block(0, "messages", 1, { category: "tool-outputs" }),
      block(1, "messages", 1, { category: "tool-outputs" }),
      block(2, "messages", 0, { category: "user" }),
      block(3, "messages", 1, { category: "tool-outputs" }),
      block(4, "messages", 1, { category: "user" }),
      block(5, "messages", 996, { category: "user" }),
    ];
    expect(barSegments(blocks, 1000).map((s) => [s.category, s.blocks.map((b) => b.position)])).toEqual([
      ["tool-outputs", [0, 1, 3]],
      ["user", [4]],
      ["user", [5]],
    ]);
  });
});
