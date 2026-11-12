import type { AdapterRecord, SessionDelta } from "@quantext/shared";
import { describe, expect, test } from "vitest";
import { claudeCodeRecords, createClaudeCodeParser } from "../../../src/adapters/claude-code/index.ts";
import { scenarios, transcriptsOf } from "../../fixtures.ts";

/** Every delta of one whole read of a scenario. */
function deltasOf(name: string): SessionDelta[] {
  const input = transcriptsOf(name);
  const parser = createClaudeCodeParser();
  const out = [parser.push(input.main), parser.flush()];
  input.subagents.forEach((agent, i) => {
    if (agent.meta !== undefined) out.push(parser.pushMeta(`subagent-${i}`, agent.meta));
    out.push(parser.push(agent.text, `subagent-${i}`), parser.flush(`subagent-${i}`));
  });
  return out;
}

describe.each(scenarios())("stored records of $version/$name", ({ name }) => {
  const deltas = deltasOf(name);
  const records: AdapterRecord[] = deltas.flatMap((d) => d.records);
  const stored = records.map((r) => claudeCodeRecords.pack(r));

  test("unpack gives back each record's value", () => {
    for (const [i, s] of stored.entries()) expect(claudeCodeRecords.unpack(s)).toEqual(records[i]?.value);
  });

  test("messages and shapes name their content by the hashes of its Blocks, so content is stored once", () => {
    const parts = new Map(
      stored
        .flatMap((s) => (s.kind === "message" ? s.parts : s.kind === "shape" ? [...s.tools, ...s.system] : []))
        .map((p) => [p.hash, p.content]),
    );
    const blocks = deltas.flatMap((d) => d.blocks);
    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) expect(parts.get(block.hash)).toEqual(block.content);
    expect(stored.filter((s) => s.kind === "message").length).toBeGreaterThan(0);
    expect(stored.filter((s) => s.kind === "shape").length).toBeGreaterThan(0);
  });
});

test("a record that is neither a message nor a shape is kept as its value", () => {
  const record = { key: "p:call-1", value: { keep: 2, tail: ["a"] } };
  expect(claudeCodeRecords.pack(record)).toEqual({ kind: "value", key: "p:call-1", value: { keep: 2, tail: ["a"] } });
});
