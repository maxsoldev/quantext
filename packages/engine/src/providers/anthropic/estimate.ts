/**
 * Token estimates for Anthropic content blocks, used only to split an exact total (ADR 6). Text and JSON by
 * characters; images by Anthropic's formula from the width and height in the image header; documents are unknown.
 */
import type { JsonValue } from "@quantext/shared";
import type { Estimate, Estimator } from "../../core/estimate.ts";

/**
 * Characters per token. Fitted on the 2.1.322 fixtures (Opus 5.5 tokenizer): the tool schemas and system prompt,
 * 35 406 characters, are 10 772 exact tokens (3.29). Prose is a little longer per token; the split is reconciled to
 * the exact total in any case.
 */
export const CHARS_PER_TOKEN = 3.3;

/** Tokens of structure around each content block (role and block markers), so that small blocks get a share. */
export const BLOCK_OVERHEAD_TOKENS = 5;

/** Image tokens are width x height / 750, after the image is scaled to at most 1568 pixels on its long edge. */
const IMAGE_PIXELS_PER_TOKEN = 750;
const IMAGE_MAX_EDGE = 1568;

/** The default estimator for Anthropic content. Pass another to `estimateRequest` to change it. */
export const estimateBlock: Estimator = (block) => {
  const estimate = estimateContent(block.content);
  const min = minimumTokens(block.content);
  return min === undefined ? estimate : { ...estimate, min };
};

/** The fewest tokens a tool result can have: its tool use id and the structure of a block. */
function minimumTokens(content: JsonValue): number | undefined {
  const block = asObject(content);
  if (block?.type !== "tool_result") return undefined;
  return Math.ceil(String(block.tool_use_id ?? "").length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD_TOKENS;
}

function estimateContent(content: JsonValue): Estimate {
  const parts = partsOf(content);
  if (parts.some((part) => part.method === "unknown")) return { tokens: 0, method: "unknown" };
  const chars = parts.reduce((sum, part) => sum + part.chars, 0);
  const imageTokens = parts.reduce((sum, part) => sum + part.imageTokens, 0);
  const tokens = Math.ceil(chars / CHARS_PER_TOKEN) + imageTokens + BLOCK_OVERHEAD_TOKENS;
  return { tokens, method: imageTokens > 0 ? "image" : "chars" };
}

interface Part {
  method: Estimate["method"];
  chars: number;
  imageTokens: number;
}

/** The measurable parts of one content block: its text, its JSON, the images and documents it holds. */
function partsOf(content: JsonValue): Part[] {
  const block = asObject(content);
  const chars = (n: number): Part => ({ method: "chars", chars: n, imageTokens: 0 });
  if (block === undefined) return [chars(JSON.stringify(content).length)];
  switch (block.type) {
    case "text":
      return [chars(String(block.text ?? "").length)];
    case "thinking":
      return [chars(String(block.thinking ?? "").length)];
    case "redacted_thinking":
      return [chars(0)];
    case "tool_use":
      return [
        chars(
          String(block.id ?? "").length + String(block.name ?? "").length + JSON.stringify(block.input ?? null).length,
        ),
      ];
    case "tool_result": {
      const id = chars(String(block.tool_use_id ?? "").length);
      const inner = block.content;
      if (typeof inner === "string") return [id, chars(inner.length)];
      return Array.isArray(inner) ? [id, ...inner.flatMap(partsOf)] : [id];
    }
    case "tool_reference":
      return [chars(String(block.tool_name ?? "").length)];
    case "image": {
      const tokens = imageTokens(block);
      return [
        tokens === undefined
          ? { method: "unknown", chars: 0, imageTokens: 0 }
          : { method: "image", chars: 0, imageTokens: tokens },
      ];
    }
    case "document":
      return [{ method: "unknown", chars: 0, imageTokens: 0 }];
    default:
      return [chars(JSON.stringify(content).length)];
  }
}

function imageTokens(block: { [key: string]: JsonValue }): number | undefined {
  const data = asObject(block.source)?.data;
  const size = typeof data === "string" ? imageSize(data) : undefined;
  if (size === undefined) return undefined;
  const scale = Math.min(1, IMAGE_MAX_EDGE / Math.max(size.width, size.height));
  return Math.ceil((Math.round(size.width * scale) * Math.round(size.height * scale)) / IMAGE_PIXELS_PER_TOKEN);
}

/** Width and height from the header of a base64 PNG, GIF, JPEG or WebP image; undefined for other data. */
export function imageSize(base64: string): { width: number; height: number } | undefined {
  const bytes = decodeBase64(base64);
  if (bytes === undefined) return undefined;
  const at = (i: number) => bytes[i] ?? 0;
  const be16 = (i: number) => (at(i) << 8) | at(i + 1);
  const le16 = (i: number) => at(i) | (at(i + 1) << 8);
  const be32 = (i: number) => be16(i) * 65536 + be16(i + 2);
  const ascii = (i: number, n: number) => String.fromCharCode(...bytes.subarray(i, i + n));
  if (ascii(1, 3) === "PNG" && ascii(12, 4) === "IHDR") return { width: be32(16), height: be32(20) };
  if (ascii(0, 4) === "GIF8") return { width: le16(6), height: le16(8) };
  if (at(0) === 0xff && at(1) === 0xd8) return jpegSize(bytes, be16);
  if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") return webpSize(ascii(12, 4), at, le16);
  return undefined;
}

/** Walk the JPEG segments to the first start-of-frame marker (SOF0..SOF15 without DHT, JPG and DAC). */
function jpegSize(bytes: Uint8Array, be16: (i: number) => number): { width: number; height: number } | undefined {
  let i = 2;
  while (i + 8 < bytes.length && bytes[i] === 0xff) {
    const marker = bytes[i + 1] ?? 0;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { width: be16(i + 7), height: be16(i + 5) };
    }
    i += 2 + be16(i + 2);
  }
  return undefined;
}

function webpSize(
  chunk: string,
  at: (i: number) => number,
  le16: (i: number) => number,
): { width: number; height: number } | undefined {
  const le24 = (i: number) => at(i) | (at(i + 1) << 8) | (at(i + 2) << 16);
  if (chunk === "VP8 ") return { width: le16(26) & 0x3fff, height: le16(28) & 0x3fff };
  if (chunk === "VP8L") {
    const bits = at(21) | (at(22) << 8) | (at(23) << 16) | (at(24) << 24);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (chunk === "VP8X") return { width: le24(24) + 1, height: le24(27) + 1 };
  return undefined;
}

/** Image headers are read from the first 64 KB at most (a JPEG frame header may follow large metadata). */
const HEADER_BASE64_CHARS = 87_380; // 4/3 of 64 KB, a multiple of 4

function decodeBase64(base64: string): Uint8Array | undefined {
  const head = base64.slice(0, HEADER_BASE64_CHARS);
  const whole = head.slice(0, head.length - (head.length % 4));
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(whole)) return undefined;
  const binary = atob(whole);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function asObject(value: JsonValue | undefined): { [key: string]: JsonValue } | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;
}
