/** Attachment rows name the source of the context the harness injects; matching Blocks take it as their source. */
import { describe, expect, test } from "vitest";
import { parseClaudeCodeSession } from "../../../src/adapters/claude-code/index.ts";
import { mainRows, transcriptsOf } from "../../fixtures.ts";

const renderedOf = (scenario: string, type: string): string[] =>
  mainRows(scenario)
    .filter((r) => r.type === "attachment" && (r.attachment as { type?: string }).type === type)
    .flatMap((r) => (r.rendered as { content: string }[] | undefined)?.map((x) => x.content) ?? []);

describe("attachments", () => {
  const graph = parseClaudeCodeSession(transcriptsOf("basic-tools"));

  test("give the Block of a skill listing its source and make it a reminder", () => {
    const effort = parseClaudeCodeSession(transcriptsOf("effort"));
    const [text] = renderedOf("effort", "skill_listing");
    expect(effort.blocks.find((b) => b.text === text)).toMatchObject({
      kind: "reminder",
      source: { attachment: "skill_listing" },
    });
  });

  test("make injected session context a reminder, also when the Block's text ends with one more newline", () => {
    const [text] = renderedOf("basic-tools", "session_context");
    const block = graph.blocks.find((b) => b.text.trim() === text?.trim());
    expect(block?.text).not.toBe(text);
    expect(block).toMatchObject({ kind: "reminder", source: { attachment: "session_context" } });
  });

  test("of an @file keep the tool and file of the reminder, and add the attachment", () => {
    const resume = parseClaudeCodeSession(transcriptsOf("resume"));
    const texts = renderedOf("resume", "file");
    expect(texts).toHaveLength(2);
    for (const text of texts) {
      expect(resume.blocks.find((b) => b.text === text)?.source).toMatchObject({
        tool: "Read",
        attachment: "file",
        filePath: expect.stringMatching(/notes\.txt$/),
      });
    }
  });

  test("leave Blocks they do not render exactly as they were", () => {
    const sources = graph.blocks.filter((b) => b.source.attachment !== undefined).length;
    const rendered = mainRows("basic-tools").filter((r) => Array.isArray(r.rendered)).length;
    expect(sources).toBeGreaterThan(0);
    expect(sources).toBeLessThanOrEqual(rendered);
    expect(graph.blocks.filter((b) => b.kind === "user").every((b) => b.source.attachment === undefined)).toBe(true);
  });

  test("that render nothing are counted as ignored", () => {
    expect(graph.report.ignoredRecords.find((r) => r.kind === "attachment")?.count).toBe(2); // two prompt_snapshot rows
  });
});
