import type { SessionMessage } from "claude-code";
import { expect, mock, test } from "claude-code/testing";
import { clearToolCalls } from "../src/clear-tool-calls.ts";
import { command, toasts } from "./kit.ts";

const call = (id: string, tool: string, input: Record<string, unknown>): SessionMessage => ({
  role: "assistant",
  text: "",
  toolUses: [{ tool_use_id: id, tool, input }],
  handle: `a${id}`,
});
const result = (id: string): SessionMessage => ({
  role: "user",
  text: "",
  toolUses: [],
  toolResults: [{ tool_use_id: id, text: "ok", isError: false }],
  handle: `r${id}`,
});
const inputOf = (m: SessionMessage | undefined) => m?.toolUses[0]?.input;
const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i} ${"x".repeat(40)}`).join("\n");

test("a big Write keeps its path and gets a stub in place of the content", () => {
  const r = clearToolCalls([call("1", "Write", { file_path: "docs/x.md", content: "w".repeat(16_800) })]);
  expect(inputOf(r.messages[0])).toEqual({
    file_path: "docs/x.md",
    content: "[Old tool input cleared: Write docs/x.md (4.2k tokens)]",
  });
  expect(r.messages[0]?.toolUses[0]?.tool_use_id).toBe("1");
  expect(r.messages[0]?.toolUses[0]?.tool).toBe("Write");
  expect(r.messages[0]?.handle).toBeUndefined();
  expect(r.cleared).toBe(1);
});

test("Bash, Edit, Agent and SendMessage stubs name the call and its size", () => {
  const big = "m".repeat(7_200);
  const r = clearToolCalls([
    call("1", "Bash", { command: `pnpm check && cat <<'EOF'\n${lines(39)}`, description: "check" }),
    call("2", "Edit", { file_path: "src/x.tsx", old_string: lines(8), new_string: lines(12) }),
    call("3", "Agent", { description: "Review step 7", subagent_type: "general-purpose", prompt: big }),
    call("4", "SendMessage", { to: "reviewer", message: big }),
  ]);
  expect(r.messages.map((m) => inputOf(m))).toEqual([
    { command: "[Old tool input cleared: Bash: pnpm check && cat <<'EOF' … (1 of 40 lines)]", description: "check" },
    { file_path: "src/x.tsx", old_string: "", new_string: "[Old tool input cleared: Edit src/x.tsx (12 lines)]" },
    {
      description: "Review step 7",
      subagent_type: "general-purpose",
      prompt: '[Old tool input cleared: Agent (general-purpose): "Review step 7" (1.8k tokens)]',
    },
    { to: "reviewer", message: "[Old tool input cleared: SendMessage to reviewer (1.8k tokens)]" },
  ]);
});

test("another tool keeps its small fields, empties its big ones, and gets the stub in its biggest string", () => {
  const todos = Array.from({ length: 40 }, (_, i) => ({ content: `todo ${i} ${"t".repeat(30)}`, status: "pending" }));
  const r = clearToolCalls([call("1", "mcp__x__y", { mode: "fast", body: "b".repeat(4_000), todos })]);
  expect(inputOf(r.messages[0])).toEqual({
    mode: "fast",
    body: "[Old tool input cleared: mcp__x__y (1.7k tokens)]",
    todos: [],
  });
});

test("small inputs, the last N calls and earlier stubs stay as they are", () => {
  const chat = [
    call("1", "Write", { file_path: "a", content: "a".repeat(4_000) }),
    result("1"),
    call("2", "Read", { file_path: "b" }),
    result("2"),
    call("3", "Write", { file_path: "c", content: "c".repeat(4_000) }),
    result("3"),
  ];
  const once = clearToolCalls(chat, 1);
  expect(once.cleared).toBe(1);
  expect(once.messages.map((m) => m.handle)).toEqual([undefined, "r1", "a2", "r2", "a3", "r3"]);
  const again = clearToolCalls(once.messages, 2);
  expect(again.cleared).toBe(0);
  expect(again.messages[0]).toBe(once.messages[0]);
});

const chat: SessionMessage[] = [
  { role: "user", text: "write it", toolUses: [], handle: "p" },
  call("1", "Write", { file_path: "a.md", content: "a".repeat(8_000) }),
  { ...result("1"), toolResults: [{ tool_use_id: "1", text: "o".repeat(4_000), isError: false }] },
];

test("/clear-tool-calls and /clear-tools queue their /compact once the command has returned", async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 });
  const queued: string[] = [];
  on("command.run", { command: "compact" }, (_$, e) => {
    queued.push(e.args);
    return { value: { text: "" } } as never;
  });
  expect((await $.command.run(command("clear-tool-calls", "keep 2"))).text).toBe(
    "Clearing tool calls, keeping the last 2…",
  );
  expect((await $.command.run(command("clear-tools", ""))).text).toBe("Clearing tool calls and outputs…");
  expect((await $.command.run(command("clear-tool-calls", "all"))).text).toBe("Usage: /clear-tool-calls [keep N]");
  await clock.advance(1);
  expect(queued).toEqual(["tool-calls keep 2", "tools keep 0"]);
});

test("/compact tool-calls stubs old tool inputs in place of a summary; tools does inputs and outputs", async ($, on) => {
  mock.clock(on, { now: 1_000_000 });
  const seen = toasts(on);
  let summarised = false;
  on("session.compact", () => {
    summarised = true;
    return { messages: [] };
  });
  const calls = await $.session.compact({ trigger: "manual", instructions: "tool-calls", messages: chat } as never);
  expect(summarised).toBe(false);
  expect(calls.messages?.[1]?.toolUses[0]?.input.content).toBe("[Old tool input cleared: Write a.md (2.0k tokens)]");
  expect(calls.messages?.[2]?.toolResults?.[0]?.text).toBe("o".repeat(4_000));
  const both = await $.session.compact({ trigger: "manual", instructions: "tools", messages: chat } as never);
  expect(both.messages?.[1]?.toolUses[0]?.input.content).toBe("[Old tool input cleared: Write a.md (2.0k tokens)]");
  expect(both.messages?.[2]?.toolResults?.[0]?.text).toBe("[Old tool result content cleared]");
  expect(seen).toEqual(["Cleared 1 tool calls (~2k tokens)", "Cleared 1 tool calls and 1 tool outputs (~3k tokens)"]);
});

test("a failed clear-tool-calls skips the compaction rather than pay for a summary", async ($, on) => {
  mock.clock(on, { now: 1_000_000 });
  let summarised = false;
  on("session.compact", () => {
    summarised = true;
    return { messages: [] };
  });
  const broken = { role: "assistant", text: "", handle: "b" }; // no toolUses: it throws
  const r = await $.session.compact({ trigger: "manual", instructions: "tool-calls", messages: [broken] } as never);
  expect(summarised).toBe(false);
  expect(r).toEqual({ skip: "quantext: clearing tool calls failed" });
});
