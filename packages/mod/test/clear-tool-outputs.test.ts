import type { SessionMessage } from "claude-code";
import { expect, mock, test } from "claude-code/testing";
import { clearToolOutputs, parseKeep } from "../src/clear-tool-outputs.ts";
import { command, toasts } from "./kit.ts";

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

test("keep parses as N, keep N or nothing", () => {
  expect(parseKeep("")).toBe(0);
  expect(parseKeep(" 12 ")).toBe(12);
  expect(parseKeep("keep 3")).toBe(3);
  expect(parseKeep("KEEP 3")).toBe(3);
  expect(parseKeep("all of it")).toBeUndefined();
  expect(parseKeep("keep -1")).toBeUndefined();
  expect(parseKeep("keep 1.5")).toBeUndefined();
});

test("/clear-tool-outputs keep N queues /compact tool-outputs keep N once the command has returned", async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 });
  const queued: string[] = [];
  on("command.run", { command: "compact" }, (_$, e) => {
    queued.push(e.args);
    return { value: { text: "" } } as never;
  });
  const r = await $.command.run(command("clear-tool-outputs", "keep 2"));
  expect(r.text).toBe("Clearing tool outputs, keeping the last 2…");
  expect(queued).toEqual([]);
  await clock.advance(1);
  expect(queued).toEqual(["tool-outputs keep 2"]);
});

test("/clear-tool-outputs with other words answers its usage and compacts nothing", async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 });
  const queued: string[] = [];
  on("command.run", { command: "compact" }, (_$, e) => {
    queued.push(e.args);
    return { value: { text: "" } } as never;
  });
  const r = await $.command.run(command("clear-tool-outputs", "everything"));
  expect(r.text).toBe("Usage: /clear-tool-outputs [keep N]");
  await clock.advance(1);
  expect(queued).toEqual([]);
});

test("/compact tool-outputs keep N stubs old tool outputs in place of a summary", async ($, on) => {
  mock.clock(on, { now: 1_000_000 });
  const seen = toasts(on);
  let summarised = false;
  on("session.compact", () => {
    summarised = true;
    return { messages: [] };
  });
  const r = await $.session.compact({
    trigger: "manual",
    instructions: "tool-outputs keep 1",
    messages: chat,
  } as never);
  expect(summarised).toBe(false);
  expect(r.messages?.map((m) => m.toolResults?.[0]?.text ?? m.text)).toEqual([
    "read them",
    "",
    CLEARED,
    "",
    CLEARED,
    "",
    "z".repeat(40),
  ]);
  expect(seen).toEqual(["Cleared 2 tool outputs (~1k tokens), kept the last 1"]);
});

test("any other compaction, and a subagent's, is left to Claude Code", async ($, on) => {
  mock.clock(on, { now: 1_000_000 });
  const summary = [{ role: "user" as const, text: "summary", toolUses: [] }];
  on("session.compact", () => ({ messages: summary }));
  const plain = await $.session.compact({ trigger: "manual", instructions: "keep the plan", messages: chat } as never);
  expect(plain.messages).toEqual(summary);
  const sub = await $.session.compact({
    trigger: "manual",
    agentId: "a1",
    instructions: "tool-outputs",
    messages: chat,
  } as never);
  expect(sub.messages).toEqual(summary);
});
