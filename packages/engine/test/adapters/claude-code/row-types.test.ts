/** Session rows besides requests and messages: titles, names, turn times, links, modes, notes, ignored rows. */
import { describe, expect, test } from "vitest";
import { parseClaudeCodeSession } from "../../../src/adapters/claude-code/index.ts";
import { transcriptsOf } from "../../fixtures.ts";

const S = "00000000-0000-4000-8000-000000000001";
const line = (row: object) => `${JSON.stringify(row)}\n`;
const { main } = transcriptsOf("basic-tools");
const parse = (extra: string) => parseClaudeCodeSession({ main: main + extra, subagents: [] });

describe("session rows", () => {
  test("a title from the harness, replaced by the user's own title, which a later harness title does not undo", () => {
    const graph = parse(
      line({ type: "ai-title", sessionId: S, aiTitle: "Harness title" }) +
        line({ type: "custom-title", sessionId: S, customTitle: "My title" }) +
        line({ type: "ai-title", sessionId: S, aiTitle: "Later harness title" }),
    );
    expect(graph.sessions[0]).toMatchObject({ title: "My title", titleSource: "user" });
    expect(parse(line({ type: "ai-title", sessionId: S, aiTitle: "Harness title" })).sessions[0]).toMatchObject({
      title: "Harness title",
      titleSource: "harness",
    });
  });

  test("an agent name", () => {
    expect(parse(line({ type: "agent-name", sessionId: S, agentName: "reviewer" })).sessions[0]?.agentName).toBe(
      "reviewer",
    );
  });

  test("the duration of a turn goes on the last Call of the turn", () => {
    const graph = parse(
      line({
        type: "system",
        subtype: "turn_duration",
        sessionId: S,
        timestamp: "2026-11-12T01:00:00.000Z",
        durationMs: 4321,
      }),
    );
    expect(graph.calls.at(-1)?.turnDurationMs).toBe(4321);
    expect(graph.calls.slice(0, -1).every((c) => c.turnDurationMs === undefined)).toBe(true);
  });

  test("links, mode changes, cwd changes and notes are events on the Session's timeline, in order", () => {
    const graph = parse(
      line({
        type: "pr-link",
        sessionId: S,
        timestamp: "2026-11-12T01:00:00.000Z",
        prNumber: 7,
        prRepository: "o/r",
        prUrl: "https://example.invalid/pr/7",
      }) +
        line({ type: "permission-mode", sessionId: S, permissionMode: "plan" }) +
        line({ type: "relocated", sessionId: S, relocatedCwd: "/fixture-elsewhere" }) +
        line({
          type: "system",
          subtype: "away_summary",
          sessionId: S,
          timestamp: "2026-11-12T01:00:05.000Z",
          content: "While away: tests ran.",
        }) +
        line({
          type: "continued-in",
          sessionId: S,
          timestamp: "2026-11-12T01:00:06.000Z",
          continuedInSessionId: "next-session",
        }),
    );
    expect(graph.events.map((e) => [e.sessionId, e.kind, e.value])).toEqual([
      [S, "pr", "https://example.invalid/pr/7"],
      [S, "mode", "plan"],
      [S, "cwd", "/fixture-elsewhere"],
      [S, "note", "While away: tests ran."],
      [S, "continued-in", "next-session"],
    ]);
    expect(graph.events[0]?.detail).toEqual({ number: 7, repository: "o/r" });
    // A row without a time takes the time of the latest row before it.
    expect(graph.events[1]?.ts).toBe(graph.events[0]?.ts);
    expect(graph.events[3]?.ts).toBe("2026-11-12T01:00:05.000Z");
  });

  test("a subagent forked from its parent's context links to the parent", () => {
    const { main: parent, subagents } = transcriptsOf("subagent");
    const agent = subagents[0];
    if (agent === undefined) throw new Error("the subagent scenario has a subagent");
    const agentId = /"agentId":"([^"]+)"/.exec(agent.text)?.[1] ?? "";
    const fork = line({
      type: "fork-context-ref",
      agentId,
      contextLength: 12,
      parentLastUuid: "u-1",
      parentSessionId: "00000000-0000-4000-8000-000000000002",
    });
    const graph = parseClaudeCodeSession({ main: parent, subagents: [{ ...agent, text: agent.text + fork }] });
    const event = graph.events.find((e) => e.kind === "forked-from");
    expect(event).toMatchObject({
      sessionId: `00000000-0000-4000-8000-000000000002:agent-${agentId}`,
      value: "00000000-0000-4000-8000-000000000002",
    });
    expect(event?.detail).toEqual({ contextLength: 12, parentLastUuid: "u-1" });
  });

  test("rows that hold nothing for the domain are counted as ignored, not as unknown", () => {
    const kinds = [
      "dev-mods",
      "started",
      "result",
      "launched",
      "file-history-snapshot",
      "file-history-delta",
      "worktree-state",
    ];
    const subtypes = ["local_command", "stop_hook_summary", "informational", "scheduled_task_fire", "agents_killed"];
    const graph = parse(
      kinds.map((type) => line({ type, sessionId: S })).join("") +
        subtypes.map((subtype) => line({ type: "system", subtype, sessionId: S })).join(""),
    );
    expect(graph.report.unknownRecords).toEqual([]);
    const ignored = new Map(graph.report.ignoredRecords.map((r) => [r.kind, r.count]));
    for (const kind of [...kinds, ...subtypes.map((s) => `system/${s}`)]) expect(ignored.get(kind)).toBe(1);
    expect(ignored.get("attachment")).toBeGreaterThan(0);
  });
});
