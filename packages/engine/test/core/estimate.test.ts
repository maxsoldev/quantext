import type { Block } from "@quantext/shared";
import { describe, expect, test } from "vitest";
import {
  BLOCK_OVERHEAD_TOKENS,
  CHARS_PER_TOKEN,
  estimateBlock,
  estimateRequest,
  imageSize,
} from "../../src/core/estimate.ts";

const block = (kind: Block["kind"], content: Block["content"]): Block => ({ hash: kind, kind, source: {}, content });

// A 96 x 64 PNG: the 8-byte signature, then the IHDR chunk with width and height (big-endian).
const PNG_96x64 = "iVBORw0KGgoAAAANSUhEUgAAAGAAAABACAIAAABq";
// A 1-pixel GIF89a header with width 640 and height 480 (little-endian).
const GIF_640x480 = btoa("GIF89a\x80\x02\xe0\x01");

describe("imageSize", () => {
  test("reads width and height from a PNG header", () => {
    expect(imageSize(PNG_96x64)).toEqual({ width: 96, height: 64 });
  });

  test("reads width and height from a GIF header", () => {
    expect(imageSize(GIF_640x480)).toEqual({ width: 640, height: 480 });
  });

  test("reads width and height from a JPEG start-of-frame segment", () => {
    // SOI, an APP0 segment of 16 bytes, then SOF0 with height 300 and width 400.
    const jpeg = [
      0xff,
      0xd8,
      0xff,
      0xe0,
      0x00,
      0x10,
      ...Array(14).fill(0),
      0xff,
      0xc0,
      0x00,
      0x11,
      0x08,
      0x01,
      0x2c,
      0x01,
      0x90,
    ];
    expect(imageSize(btoa(String.fromCharCode(...jpeg)))).toEqual({ width: 400, height: 300 });
  });

  test("returns undefined for data that is not a known image format", () => {
    expect(imageSize(btoa("not an image at all"))).toBeUndefined();
  });
});

describe("estimateBlock", () => {
  test("estimates text by characters, plus the overhead of a block", () => {
    const text = "x".repeat(330);
    expect(estimateBlock(block("user", { type: "text", text }))).toEqual({
      tokens: Math.ceil(330 / CHARS_PER_TOKEN) + BLOCK_OVERHEAD_TOKENS,
      method: "chars",
    });
  });

  test("counts the tool use id of a tool call and of a tool result", () => {
    const use = { type: "tool_use", id: "x".repeat(33), name: "", input: "" };
    const result = { type: "tool_result", tool_use_id: "x".repeat(33), content: "" };
    const expected = Math.ceil(35 / CHARS_PER_TOKEN) + BLOCK_OVERHEAD_TOKENS; // id + the JSON '""' of the input
    expect(estimateBlock(block("tool-call", use)).tokens).toBe(expected);
    expect(estimateBlock(block("tool-result", result)).tokens).toBe(
      Math.ceil(33 / CHARS_PER_TOKEN) + BLOCK_OVERHEAD_TOKENS,
    );
  });

  test("estimates an image by width x height / 750 from its header, not by its base64 length", () => {
    const image = { type: "image", source: { type: "base64", media_type: "image/png", data: PNG_96x64 } };
    expect(estimateBlock(block("image", image))).toEqual({
      tokens: Math.ceil((96 * 64) / 750) + BLOCK_OVERHEAD_TOKENS,
      method: "image",
    });
  });

  test("scales a large image down to 1568 pixels on the long edge first", () => {
    const big = btoa("GIF89a\x40\x1f\xa0\x0f"); // 8000 x 4000
    const image = { type: "image", source: { type: "base64", media_type: "image/gif", data: big } };
    expect(estimateBlock(block("image", image)).tokens).toBe(Math.ceil((1568 * 784) / 750) + BLOCK_OVERHEAD_TOKENS);
  });

  test("estimates an image inside a tool result by its header too", () => {
    const image = { type: "image", source: { type: "base64", media_type: "image/png", data: PNG_96x64 } };
    const result = { type: "tool_result", tool_use_id: "", content: [image] };
    expect(estimateBlock(block("tool-result", result))).toEqual({
      tokens: Math.ceil((96 * 64) / 750) + BLOCK_OVERHEAD_TOKENS,
      method: "image",
    });
  });

  test("marks a document as unknown", () => {
    const doc = { type: "document", source: { type: "base64", media_type: "application/pdf", data: "JVBERi0x" } };
    expect(estimateBlock(block("document", doc))).toEqual({ tokens: 0, method: "unknown" });
  });
});

describe("estimateRequest", () => {
  const deferred = block("tool-schema", { name: "mcp__x__y", description: "d".repeat(300), defer_loading: true });
  const reference = block("tool-result", {
    type: "tool_result",
    tool_use_id: "t",
    content: [{ type: "tool_reference", tool_name: "mcp__x__y" }],
  });

  test("gives a deferred tool schema no tokens while no tool reference loads it", () => {
    expect(estimateRequest([deferred])[0]?.tokens).toBe(0);
  });

  test("estimates a deferred tool schema once a tool reference loads it", () => {
    expect(estimateRequest([deferred, reference])[0]?.tokens).toBeGreaterThan(0);
  });
});
