import type { CallIssue } from "@quantext/shared";
import { expect, test } from "vitest";
import { parseClaudeCodeSession } from "../../../src/adapters/claude-code/index.ts";

const sorted = (issues: readonly CallIssue[]) =>
  [...issues].sort(
    (a, b) =>
      (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0) || (a.detail < b.detail ? -1 : a.detail > b.detail ? 1 : 0),
  );

test("a Call's issues come in one order (by kind, then detail), however the log was read", () => {
  const request = {
    type: "api-request",
    sessionId: "00000000-0000-4000-8000-0000000000aa",
    id: "c0",
    params: { model: "claude-opus-5-5" },
    keep: 0,
    tail: ["zz-not-in-the-log", "aa-not-in-the-log"],
    cacheControl: [],
  };
  const call = parseClaudeCodeSession({ main: `${JSON.stringify(request)}\n`, subagents: [] }).calls[0];
  expect(call?.issues.length).toBeGreaterThan(2);
  expect(call?.issues).toEqual(sorted(call?.issues ?? []));
});
