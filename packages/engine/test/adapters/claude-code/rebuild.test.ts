import { describe, expect, test } from "vitest";
import type { ClaudeCodeTranscripts } from "../../../src/adapters/claude-code/index.ts";
import { parseClaudeCodeSession } from "../../../src/adapters/claude-code/index.ts";
import { rebuildRequests } from "../../../src/adapters/claude-code/rebuild.ts";
import { readRows } from "../../../src/adapters/claude-code/rows.ts";
import { scenarios, transcriptsOf } from "../../fixtures.ts";

function requestsOf(transcripts: ClaudeCodeTranscripts) {
  const report = { unknownRecords: {}, unreadable: [] };
  const all = [
    readRows("main", transcripts.main, report),
    ...transcripts.subagents.map((s, i) => readRows(`subagent-${i}`, s.text, report)),
  ];
  return { rows: all.flat(), requests: rebuildRequests(all.flat()) };
}

describe.each(scenarios())("rebuild of $version/$name", ({ name }) => {
  const { rows, requests } = requestsOf(transcriptsOf(name));
  const logged = rows.filter((row) => row.type === "api-request");

  test.each(logged.map((row) => [row.data.id as string, row.data] as const))(
    "call %s resolves to keep + tail messages and its shape",
    (id, data) => {
      const request = requests.get(id);
      expect(request?.missing).toEqual([]);
      expect(request?.messages).toHaveLength((data.keep as number) + (data.tail as unknown[]).length);
      expect(request?.shape?.system.length).toBeGreaterThan(0);
      expect(request?.shape?.tools.length).toBeGreaterThan(0);
    },
  );

  test("no Call has an issue", () => {
    const graph = parseClaudeCodeSession(transcriptsOf(name));
    expect(graph.calls.filter((call) => call.issues.length > 0)).toEqual([]);
  });
});

describe("rebuild of split and joined messages", () => {
  test("an assistant message written over several rows is one message with every block, in order", () => {
    const { requests } = requestsOf(transcriptsOf("basic-tools"));
    // Call 7 follows call 6, whose response was three rows: thinking, text, tool use.
    const messages = requests.get("a90c1693-473b-43b0-aebd-df4315facde5")?.messages ?? [];
    expect(messages[13]?.role).toBe("assistant");
    expect(messages[13]?.content.map((block) => (block as { type: string }).type)).toEqual([
      "thinking",
      "text",
      "tool_use",
    ]);
  });

  test("a Skill tool result and the skill text after it are one user message", () => {
    const { requests } = requestsOf(transcriptsOf("resume"));
    const messages = requests.get("3b131579-d4ad-4b4e-a5d8-13c078886c02")?.messages ?? [];
    expect(messages[8]?.role).toBe("user");
    expect(messages[8]?.content.map((block) => (block as { type: string }).type)).toEqual(["tool_result", "text"]);
  });

  test("a string prompt is one text block", () => {
    const { requests } = requestsOf(transcriptsOf("resume"));
    const first = requests.get("47bdeb4d-fd08-4a14-a4b7-3747cc2024b7")?.messages[0];
    expect(first?.content).toHaveLength(1);
    expect(first?.content[0]).toMatchObject({ type: "text" });
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
  });
});
