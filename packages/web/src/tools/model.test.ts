import type { ToolCallSummary, ToolOutput } from "@quantext/shared";
import { describe, expect, test } from "vitest";
import { editDiff, inputSummary, toolRows } from "./model.ts";

const call = (id: string, callIndex: number, name: string, resultTokens: number): ToolCallSummary => ({
  id,
  callId: `c${callIndex}`,
  callIndex,
  name,
  source: { tool: name },
  input: {},
  isError: false,
  parallel: 1,
  resultTokens,
});

const output = (toolUseId: string, calls: number, total: number): ToolOutput =>
  ({
    toolUseId,
    tool: "Read",
    source: {},
    isError: false,
    calls,
    runs: 1,
    lifetimeTokens: 0,
    tokensByPart: { cacheRead: 0, cacheWrite: 0, input: 0 },
    costUsd: { cacheRead: 0, cacheWrite: 0, input: 0, total },
  }) as ToolOutput;

describe("the tool calls of a Session", () => {
  const calls = [call("a", 0, "Bash", 20), call("b", 1, "Read", 9000), call("c", 2, "Edit", 90)];
  const outputs = [output("a", 7, 0.002), output("b", 4, 0.06), output("c", 6, 0.004)];

  test("by default, the one whose output cost the most over the session comes first", () => {
    expect(toolRows(calls, outputs, "cost").map((r) => r.call.id)).toEqual(["b", "c", "a"]);
  });

  test("other orders: result tokens, calls the output stayed in, and the order they ran", () => {
    expect(toolRows(calls, outputs, "tokens").map((r) => r.call.id)).toEqual(["b", "c", "a"]);
    expect(toolRows(calls, outputs, "calls").map((r) => r.call.id)).toEqual(["a", "c", "b"]);
    expect(toolRows([...calls].reverse(), outputs, "time").map((r) => r.call.id)).toEqual(["a", "b", "c"]);
  });

  test("a tool call with no result in any call has no lifetime, and sorts last by cost", () => {
    const rows = toolRows([...calls, call("d", 3, "Bash", 0)], outputs, "cost");
    expect(rows.at(-1)?.call.id).toBe("d");
    expect(rows.at(-1)?.lifetime).toBeUndefined();
  });
});

describe("a tool call's input in a few words", () => {
  test("the command, the file, the pattern or the task, as people read it", () => {
    expect(inputSummary("Bash", { command: "git log --oneline", description: "Show history" })).toBe(
      "git log --oneline",
    );
    expect(inputSummary("Read", { file_path: "/repo/src/a.ts" })).toBe("/repo/src/a.ts");
    expect(inputSummary("Grep", { pattern: "TODO", path: "src" })).toBe("TODO in src");
    expect(inputSummary("Agent", { description: "Find add", prompt: "long…" })).toBe("Find add");
  });

  test("a path inside the session's folder is shown relative to it", () => {
    expect(inputSummary("Read", { file_path: "/repo/src/a.ts" }, "/repo")).toBe("src/a.ts");
    expect(inputSummary("Read", { file_path: "/repository/a.ts" }, "/repo")).toBe("/repository/a.ts");
  });

  test("any other input as short JSON", () => {
    expect(inputSummary("mcp__x__y", { q: "a" })).toBe('{"q":"a"}');
  });
});

describe("the change an Edit made, line by line", () => {
  test("lines removed and added around the lines both share", () => {
    const d = editDiff("Edit", { old_string: "a\nb\nc", new_string: "a\nB\nc" });
    expect(d).toEqual([
      { kind: "same", text: "a" },
      { kind: "del", text: "b" },
      { kind: "add", text: "B" },
      { kind: "same", text: "c" },
    ]);
  });

  test("a MultiEdit gives each edit in turn; a Write adds all of its lines", () => {
    const m = editDiff("MultiEdit", {
      edits: [
        { old_string: "x", new_string: "y" },
        { old_string: "p", new_string: "q" },
      ],
    });
    expect(m?.map((l) => `${l.kind} ${l.text}`)).toEqual(["del x", "add y", "gap ", "del p", "add q"]);
    expect(editDiff("Write", { content: "1\n2" })).toEqual([
      { kind: "add", text: "1" },
      { kind: "add", text: "2" },
    ]);
  });

  test("other tools have no diff", () => {
    expect(editDiff("Read", { file_path: "a" })).toBeUndefined();
  });
});
