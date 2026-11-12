/**
 * Claude Code merges several attached texts into one text Block. The Block gets one part per attachment it holds,
 * found by the attachment's rendered text, so the skill listing or the deferred tools list is visible as such.
 */
import type { Block } from "@quantext/shared";
import { describe, expect, test } from "vitest";
import { parseClaudeCodeSession } from "../../../src/adapters/claude-code/index.ts";
import { mainRows, scenarios, transcriptsOf } from "../../fixtures.ts";

const unwrapped = (text: string) => text.replace(/^<system-reminder>\n/, "").replace(/\n<\/system-reminder>\s*$/, "");
const renderedOf = (scenario: string, type: string): string[] =>
  mainRows(scenario)
    .filter((r) => r.type === "attachment" && (r.attachment as { type?: string }).type === type)
    .flatMap((r) => (r.rendered as { content: string }[] | undefined)?.map((x) => x.content) ?? []);
const slices = (b: Block) => (b.parts ?? []).map((p) => b.text.slice(p.start, p.end));

describe("the merged attachment Block of basic-tools", () => {
  const graph = parseClaudeCodeSession(transcriptsOf("basic-tools"));
  const merged = graph.blocks.find((b) => b.text.startsWith("# Environment"));

  test("has one part per attachment, in the order of its text, each with its kind and a label", () => {
    expect(merged?.parts?.map((p) => [p.label, p.source.attachment])).toEqual([
      ["Environment", "environment"],
      ["Model", "model"],
      ["Deferred tools", "deferred_tools_delta"],
      ["Agent listing", "agent_listing_delta"],
      ["Skill listing", "skill_listing"],
      ["Auto mode", "auto_mode"],
      ["Date", "date"],
    ]);
  });

  test("its parts cover its text end to end, and each holds the attachment's rendered text", () => {
    if (merged === undefined) throw new Error("no merged Block");
    expect(slices(merged).join("")).toBe(merged.text);
    const [skills] = renderedOf("basic-tools", "skill_listing");
    const part = merged.parts?.find((p) => p.label === "Skill listing");
    expect(merged.text.slice(part?.start, part?.end).trim()).toBe(unwrapped(skills ?? ""));
  });

  test("stays a system text of the messages, with no attachment of its own", () => {
    expect(merged).toMatchObject({ kind: "system", source: {} });
  });

  test("an attached text sent without its wrapper still gets its source", () => {
    const [text] = renderedOf("basic-tools", "silent_turn_reminder");
    const block = graph.blocks.find((b) => b.text === unwrapped(text ?? ""));
    expect(block).toMatchObject({ kind: "system", source: { attachment: "silent_turn_reminder" } });
    expect(block?.parts).toEqual([
      { start: 0, end: block?.text.length, label: "Turn reminder", source: { attachment: "silent_turn_reminder" } },
    ]);
  });
});

describe.each(scenarios().map((s) => s.name))("attachment parts in %s", (name) => {
  const graph = parseClaudeCodeSession(transcriptsOf(name));

  test("cover each Block's text end to end, with no empty part", () => {
    for (const b of graph.blocks.filter((x) => x.parts !== undefined)) {
      expect(slices(b).join(""), b.hash).toBe(b.text);
      for (const p of b.parts ?? []) expect(p.end, b.hash).toBeGreaterThan(p.start);
    }
  });

  test("every attachment that renders text is found in a request: no call has an unlocated attachment", () => {
    expect(graph.calls.flatMap((c) => c.issues).filter((i) => i.kind === "unlocated-attachment")).toEqual([]);
  });
});

describe("an attachment whose text is in no request", () => {
  const rows = mainRows("basic-tools").map((r) =>
    r.type === "attachment" && (r.attachment as { type?: string }).type === "date"
      ? { ...r, rendered: [{ content: "<system-reminder>\nA text the request does not hold.\n</system-reminder>" }] }
      : r,
  );
  const graph = parseClaudeCodeSession({ main: `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`, subagents: [] });

  test("stays in the leftover part of the merged Block, and its Call gets an issue", () => {
    const merged = graph.blocks.find((b) => b.text.startsWith("# Environment"));
    const last = merged?.parts?.at(-1);
    expect(last).toMatchObject({ label: "Other text", source: {} });
    expect(merged?.text.slice(last?.start, last?.end)).toContain("Today's date is");
    expect(graph.calls[0]?.issues).toContainEqual({
      kind: "unlocated-attachment",
      detail: "the date attachment is in no message of the request",
    });
  });
});

test("an attachment that a newer one of its type replaces before the request is not flagged", () => {
  const rows = mainRows("basic-tools");
  const at = rows.findIndex((r) => r.type === "attachment" && (r.attachment as { type?: string }).type === "date");
  const date = rows[at] as Record<string, unknown>;
  const older = {
    ...date,
    rendered: [{ content: "<system-reminder>\nToday's date is 2026-11-11.\n</system-reminder>" }],
  };
  const main = [...rows.slice(0, at), older, ...rows.slice(at)].map((r) => JSON.stringify(r)).join("\n");
  const graph = parseClaudeCodeSession({ main: `${main}\n`, subagents: [] });
  expect(graph.calls.flatMap((c) => c.issues).filter((i) => i.kind === "unlocated-attachment")).toEqual([]);
});

test("a token reminder the harness logged but did not send is counted in the report, not flagged on the call", () => {
  const rows = mainRows("basic-tools");
  const at = rows.findIndex((r) => r.type === "attachment" && (r.attachment as { type?: string }).type === "date");
  const reminder = {
    ...(rows[at] as Record<string, unknown>),
    attachment: { type: "total_tokens_reminder" },
    rendered: [{ content: "<system-reminder>\nA count the request does not hold.\n</system-reminder>" }],
  };
  const main = [...rows.slice(0, at), reminder, ...rows.slice(at)].map((r) => JSON.stringify(r)).join("\n");
  const graph = parseClaudeCodeSession({ main: `${main}\n`, subagents: [] });
  expect(graph.calls.flatMap((c) => c.issues).filter((i) => i.kind === "unlocated-attachment")).toEqual([]);
  expect(graph.report.ignoredRecords).toContainEqual({ kind: "attachment total_tokens_reminder (not sent)", count: 1 });
});
