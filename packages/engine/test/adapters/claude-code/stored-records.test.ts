import type { AdapterRecord, SessionDelta } from "@quantext/shared";
import { describe, expect, test } from "vitest";
import type { ParserState } from "../../../src/adapters/claude-code/index.ts";
import { claudeCodeCodec, createClaudeCodeParser } from "../../../src/adapters/claude-code/index.ts";
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
  const stored = records.map((r) => claudeCodeCodec.pack(r));

  test("unpack gives back each record's value", () => {
    for (const [i, s] of stored.entries()) expect(claudeCodeCodec.unpack(s)).toEqual(records[i]?.value);
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
  expect(claudeCodeCodec.pack(record)).toEqual({ kind: "value", key: "p:call-1", value: { keep: 2, tail: ["a"] } });
});

describe("content as the store keeps it", () => {
  const image = Buffer.alloc(3000, 7).toString("base64");
  const content = {
    type: "tool_result",
    tool_use_id: "toolu_1",
    content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: image } }],
  };

  test("takes base64 data out as decoded media, and puts it back", () => {
    const packed = claudeCodeCodec.packContent(content);
    expect(JSON.stringify(packed.content)).not.toContain(image.slice(0, 100));
    expect(packed.media).toHaveLength(1);
    expect(packed.media[0]?.mediaType).toBe("image/png");
    expect(Buffer.from(packed.media[0]?.bytes ?? []).equals(Buffer.alloc(3000, 7))).toBe(true);
    const bytes = new Map(packed.media.map((m) => [m.hash, m.bytes]));
    expect(claudeCodeCodec.unpackContent(packed.content, (h) => bytes.get(h) ?? new Uint8Array())).toEqual(content);
  });

  test("leaves small or non-canonical base64 as it is", () => {
    const small = { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } };
    expect(claudeCodeCodec.packContent(small)).toEqual({ content: small, media: [] });
    const odd = { type: "image", source: { type: "base64", media_type: "image/png", data: `${image}\n` } };
    expect(claudeCodeCodec.packContent(odd)).toEqual({ content: odd, media: [] });
  });

  test("gives each Block's display text from its content, as the parser does", () => {
    for (const { name } of scenarios()) {
      for (const d of deltasOf(name)) for (const b of d.blocks) expect(claudeCodeCodec.text(b.content)).toBe(b.text);
    }
  });
});

test("a parser refuses a snapshot of another parser version", () => {
  const snapshot = { ...createClaudeCodeParser().snapshot(), version: 1 } as unknown as ParserState;
  expect(() => createClaudeCodeParser(snapshot)).toThrow(/snapshot version 1/);
});
