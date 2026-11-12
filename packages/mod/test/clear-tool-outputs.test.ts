import type { SessionMessage } from "claude-code";
import { expect, test } from "claude-code/testing";
import { clearToolOutputs } from "../src/clear-tool-outputs.ts";

const CLEARED = "[Old tool result content cleared]";
const use = (id: string): SessionMessage => ({
  role: "assistant",
  text: "",
  toolUses: [{ tool_use_id: id, tool: "Read", input: { file_path: `/${id}` } }],
  handle: `a${id}`,
});
const result = (id: string, text: string): SessionMessage => ({
  role: "user",
  text: "",
  toolUses: [],
  toolResults: [{ tool_use_id: id, text, isError: false }],
  handle: `r${id}`,
});
const chat: SessionMessage[] = [
  { role: "user", text: "read them", toolUses: [], handle: "p" },
  use("1"),
  result("1", "x".repeat(5000)),
  use("2"),
  result("2", "y".repeat(300)),
  use("3"),
  result("3", "z".repeat(40)),
];

test("by default every tool output becomes the stub; other messages keep their handle", () => {
  const r = clearToolOutputs(chat);
  expect(r.cleared).toBe(3);
  expect(r.chars).toBe(5340);
  const results = r.messages.filter((m) => m.toolResults);
  expect(results.map((m) => m.toolResults?.[0]?.text)).toEqual([CLEARED, CLEARED, CLEARED]);
  expect(results.map((m) => m.handle)).toEqual([undefined, undefined, undefined]);
  expect(r.messages.filter((m) => !m.toolResults).map((m) => m.handle)).toEqual(["p", "a1", "a2", "a3"]);
});

test("keep N leaves the last N outputs whole; earlier stubs do not count toward N", () => {
  const once = clearToolOutputs(chat, 1).messages;
  expect(once[6]?.handle).toBe("r3");
  const again = clearToolOutputs([...once, use("4"), result("4", "w")], 2);
  expect(again.cleared).toBe(0);
  expect(again.messages[6]?.toolResults?.[0]?.text).toBe("z".repeat(40));
});

test("a ToolSearch result stays whole, so the deferred tools it loaded stay loaded", () => {
  const search: SessionMessage = {
    role: "assistant",
    text: "",
    toolUses: [{ tool_use_id: "s", tool: "ToolSearch", input: { query: "select:Monitor" } }],
    handle: "as",
  };
  const r = clearToolOutputs([search, result("s", "Monitor"), use("1"), result("1", "x".repeat(500))]);
  expect(r.messages[1]?.handle).toBe("rs");
  expect(r.messages[3]?.toolResults?.[0]?.text).toBe(CLEARED);
  expect(r.cleared).toBe(1);
});
