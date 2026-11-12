import { describe, expect, test } from "vitest";
import { segments, stopWords, toolInput, toolWords } from "./model.ts";

describe("segments", () => {
  test("splits a reply at fenced code, keeping the text's line breaks and the code's language", () => {
    const text = "Done.\n\nRun this:\n```sh\npnpm check\n```\nThen look.";
    expect(segments(text)).toEqual([
      { kind: "text", text: "Done.\n\nRun this:" },
      { kind: "code", text: "pnpm check", lang: "sh" },
      { kind: "text", text: "Then look." },
    ]);
  });

  test("an open fence runs to the end, as a reply still being written does", () => {
    expect(segments("a\n```\nb\nc")).toEqual([
      { kind: "text", text: "a" },
      { kind: "code", text: "b\nc" },
    ]);
  });

  test("text with no fence is one segment; empty text is none", () => {
    expect(segments("<b>not html</b>\nline 2")).toEqual([{ kind: "text", text: "<b>not html</b>\nline 2" }]);
    expect(segments("")).toEqual([]);
  });
});

test("says why the model stopped in words, and keeps an unknown reason as it is", () => {
  expect(stopWords("end_turn")).toBe("It ended its turn.");
  expect(stopWords("tool_use")).toBe("It stopped to run tools.");
  expect(stopWords("max_tokens")).toBe("It hit its output limit: the answer is cut off.");
  expect(stopWords("something_new")).toBe("It stopped: something_new.");
});

test("shows a tool call's input without the tool name the preview starts with", () => {
  expect(toolInput("Read", 'Read {"file_path":"src/a.ts"}')).toBe('{"file_path":"src/a.ts"}');
  expect(toolInput("Read", "other")).toBe("other");
});

test("says a tool call's input in words from its preview, even when the preview is cut", () => {
  expect(toolWords("Read", 'Read {"file_path":"/w/repo/src/a.ts"}', "/w/repo")).toBe("src/a.ts");
  expect(toolWords("Bash", 'Bash {"command":"ls -la","description":"Li', "/w/repo")).toBe("ls -la");
  expect(toolWords("Edit", 'Edit {"replace_all":false,"file_path":"/w/repo/src/math.ts","old_str', "/w/repo")).toBe(
    "src/math.ts",
  );
  expect(toolWords("Odd", 'Odd {"x":1}')).toBe('{"x":1}');
});
