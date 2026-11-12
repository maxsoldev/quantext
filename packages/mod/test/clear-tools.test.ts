import type { On, SessionMessage } from "claude-code";
import { expect, mock, test } from "claude-code/testing";
import { command, toasts } from "./kit.ts";

const CLEARED = "[Old tool result content cleared]";
const STUB = "[Old tool input cleared: Write a.md (2.0k tokens)]";
const USAGE = "Usage: /clear-tools [outputs] [keep N]";

const write = (id: string): SessionMessage => ({
  role: "assistant",
  text: "",
  toolUses: [{ tool_use_id: id, tool: "Write", input: { file_path: "a.md", content: "a".repeat(8_000) } }],
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
  { role: "user", text: "write it", toolUses: [], handle: "p" },
  write("1"),
  result("1", "o".repeat(4_000)),
  write("2"),
  result("2", "z".repeat(40)),
];

/** Records each `/compact` the mod queues, and the clock that lets the timer run. */
function compactions(on: On) {
  const clock = mock.clock(on, { now: 1_000_000 });
  const queued: string[] = [];
  on("command.run", { command: "compact" }, (_$, e) => {
    queued.push(e.args);
    return { value: { text: "" } } as never;
  });
  return { clock, queued };
}

test("/clear-tools queues /compact tools once the command has returned", async ($, on) => {
  const { clock, queued } = compactions(on);
  const run = async (args: string) => (await $.command.run(command("clear-tools", args))).text;
  expect(await run("")).toBe("Clearing tool calls and outputs…");
  expect(await run("keep 2")).toBe("Clearing tool calls and outputs, keeping the last 2…");
  expect(await run("outputs")).toBe("Clearing tool outputs…");
  expect(await run("OUTPUTS keep 3")).toBe("Clearing tool outputs, keeping the last 3…");
  expect(await run(" 4 ")).toBe("Clearing tool calls and outputs, keeping the last 4…");
  expect(queued).toEqual([]);
  await clock.advance(1);
  expect(queued).toEqual([
    "tools keep 0",
    "tools keep 2",
    "tools outputs keep 0",
    "tools outputs keep 3",
    "tools keep 4",
  ]);
});

test("/clear-tools with bad words says what is wrong and compacts nothing", async ($, on) => {
  const { clock, queued } = compactions(on);
  const run = async (args: string) => (await $.command.run(command("clear-tools", args))).text;
  expect(await run("keep -1")).toBe(`/clear-tools: keep needs a whole number, not "-1". ${USAGE}`);
  expect(await run("keep 1.5")).toBe(`/clear-tools: keep needs a whole number, not "1.5". ${USAGE}`);
  expect(await run("keep")).toBe(`/clear-tools: keep needs a whole number. ${USAGE}`);
  expect(await run("calls")).toBe(`/clear-tools: unknown word "calls". ${USAGE}`);
  expect(await run("keep 2 outputs")).toBe(`/clear-tools: unknown word "outputs". ${USAGE}`);
  expect(await run("keep 1 keep 2")).toBe(`/clear-tools: unknown word "keep". ${USAGE}`);
  await clock.advance(1);
  expect(queued).toEqual([]);
});

test("the old clear commands are gone", async ($, on) => {
  mock.clock(on, { now: 1_000_000 });
  const names: string[] = [];
  on("session.start", (_$, e) => ({ cwd: e.cwd }));
  on("command.register", (_$, e) => {
    names.push(e.name);
    return { value: { command: e.name } };
  });
  await $.session.start({ cwd: "/", surface: null, isInteractive: false });
  expect(names.filter((n) => n.startsWith("clear"))).toEqual(["clear-tools"]);
});

test("/compact tools stubs old tool calls and outputs in one pass, in place of a summary", async ($, on) => {
  mock.clock(on, { now: 1_000_000 });
  const seen = toasts(on);
  let summarised = false;
  on("session.compact", () => {
    summarised = true;
    return { messages: [] };
  });
  const r = await $.session.compact({ trigger: "manual", instructions: "tools keep 1", messages: chat } as never);
  expect(summarised).toBe(false);
  expect(r.messages?.map((m) => m.toolUses[0]?.input.content ?? m.toolResults?.[0]?.text ?? m.text)).toEqual([
    "write it",
    STUB,
    CLEARED,
    "a".repeat(8_000),
    "z".repeat(40),
  ]);
  expect(r.messages?.map((m) => m.toolUses[0]?.tool_use_id ?? m.toolResults?.[0]?.tool_use_id)).toEqual([
    undefined,
    "1",
    "1",
    "2",
    "2",
  ]);
  expect(seen).toEqual(["Cleared 1 tool calls and 1 tool outputs (~3k tokens), kept the last 1"]);
});

test("/compact tools outputs stubs only old tool outputs and keeps the calls", async ($, on) => {
  mock.clock(on, { now: 1_000_000 });
  const seen = toasts(on);
  const r = await $.session.compact({ trigger: "manual", instructions: "tools outputs", messages: chat } as never);
  expect(r.messages?.[1]).toEqual(chat[1]);
  expect(r.messages?.[3]).toEqual(chat[3]);
  expect(r.messages?.[2]?.toolResults?.[0]?.text).toBe(CLEARED);
  expect(r.messages?.[4]?.toolResults?.[0]?.text).toBe(CLEARED);
  expect(seen).toEqual(["Cleared 2 tool outputs (~1k tokens)"]);
});

test("the old /compact forms, any other compaction, and a subagent's are left to Claude Code", async ($, on) => {
  mock.clock(on, { now: 1_000_000 });
  const summary = [{ role: "user" as const, text: "summary", toolUses: [] }];
  on("session.compact", () => ({ messages: summary }));
  for (const instructions of ["tool-outputs", "tool-calls keep 1", "keep the plan", "tools that matter"]) {
    const r = await $.session.compact({ trigger: "manual", instructions, messages: chat } as never);
    expect(r.messages).toEqual(summary);
  }
  const sub = await $.session.compact({
    trigger: "manual",
    agentId: "a1",
    instructions: "tools",
    messages: chat,
  } as never);
  expect(sub.messages).toEqual(summary);
});

test("a failed clear skips the compaction rather than pay for a summary", async ($, on) => {
  mock.clock(on, { now: 1_000_000 });
  let summarised = false;
  on("session.compact", () => {
    summarised = true;
    return { messages: [] };
  });
  const noUses = { role: "assistant", text: "", handle: "b" }; // no toolUses: clearing calls throws
  const both = await $.session.compact({ trigger: "manual", instructions: "tools", messages: [noUses] } as never);
  expect(both).toEqual({ skip: "quantext: clearing tool calls and outputs failed" });
  const noText = { ...result("9", ""), toolResults: [{ tool_use_id: "9", isError: false }] }; // no text: it throws
  const outs = await $.session.compact({
    trigger: "manual",
    instructions: "tools outputs",
    messages: [noText],
  } as never);
  expect(outs).toEqual({ skip: "quantext: clearing tool outputs failed" });
  expect(summarised).toBe(false);
});
