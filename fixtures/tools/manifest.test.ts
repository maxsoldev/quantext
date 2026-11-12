import { describe, expect, test } from "vitest";
import { summariseTranscript } from "./manifest.ts";

describe("summariseTranscript", () => {
  test("counts rows by type and LLM calls (api-request rows), sorted by type", () => {
    const text = [
      '{"type":"user"}',
      '{"type":"api-request"}',
      '{"type":"assistant"}',
      '{"type":"api-request"}',
      '{"type":"assistant"}',
      "",
    ].join("\n");
    expect(summariseTranscript("s.jsonl", text)).toEqual({
      rows: 5,
      llmCalls: 2,
      rowTypes: { "api-request": 2, assistant: 2, user: 1 },
    });
  });

  test("counts a row without a type as `(none)`", () => {
    expect(summariseTranscript("s.jsonl", '{"a":1}\n').rowTypes).toEqual({ "(none)": 1 });
  });

  test("fails with the file and line on a row that is not JSON", () => {
    expect(() => summariseTranscript("s.jsonl", '{"type":"user"}\n{bad\n')).toThrow(/s\.jsonl:2/);
  });
});
