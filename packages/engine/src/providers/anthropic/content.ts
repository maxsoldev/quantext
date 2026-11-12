/** Anthropic content blocks as plain text for display, so no surface needs the provider's JSON. */
import type { JsonValue } from "@quantext/shared";
import { imageSize } from "./estimate.ts";

/** The display text of one content block, tool schema or system block. */
export function blockText(content: JsonValue): string {
  const block = asObject(content);
  if (block === undefined) return typeof content === "string" ? content : JSON.stringify(content);
  if (typeof block.name === "string" && "input_schema" in block)
    return `${block.name}: ${String(block.description ?? "")}`;
  switch (block.type) {
    case "text":
      return String(block.text ?? "");
    case "thinking":
      return block.thinking ? String(block.thinking) : "[reasoning]";
    case "redacted_thinking":
      return "[reasoning]";
    case "tool_use":
      return `${String(block.name ?? "")} ${JSON.stringify(block.input ?? null)}`;
    case "tool_result": {
      const inner = block.content;
      if (typeof inner === "string") return inner;
      return Array.isArray(inner) ? inner.map(blockText).join("\n") : "";
    }
    case "tool_reference":
      return `[tool ${String(block.tool_name ?? "")}]`;
    case "image": {
      const data = asObject(block.source)?.data;
      const size = typeof data === "string" ? imageSize(data) : undefined;
      return size === undefined ? "[image]" : `[image ${size.width}x${size.height}]`;
    }
    case "document":
      return "[document]";
    default:
      return JSON.stringify(content);
  }
}

function asObject(value: JsonValue | undefined): { [key: string]: JsonValue } | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;
}

/** The tool names a content block loads with `tool_reference` blocks (in a tool result). */
export function toolReferences(content: JsonValue): string[] {
  const block = asObject(content);
  if (block === undefined) return [];
  if (block.type === "tool_reference" && typeof block.tool_name === "string") return [block.tool_name];
  return Array.isArray(block.content) ? block.content.flatMap(toolReferences) : [];
}

/** A tool schema with `defer_loading`: it is sent only where a `tool_reference` loads it. */
export function isDeferredSchema(tool: JsonValue): boolean {
  return asObject(tool)?.defer_loading === true;
}

/**
 * Whether the model keeps the thinking of earlier assistant turns in its context (and bills it as input). Claude
 * Opus 4.5 and later, Sonnet 5 and later, Haiku 5.5, Fable and Mythos do; earlier models drop it, except in the
 * last assistant turn of a tool loop.
 */
export function replaysThinking(canonicalModel: string | undefined): boolean {
  if (canonicalModel === undefined) return true;
  if (/^claude-(fable|mythos)-/.test(canonicalModel)) return true;
  const match = /^claude-(opus|sonnet|haiku)-(\d+)(?:-(\d+))?$/.exec(canonicalModel);
  if (match === null) return true;
  const version = Number(match[2]) + Number(match[3] ?? 0) / 10;
  if (match[1] === "opus") return version >= 4.5;
  if (match[1] === "sonnet") return version >= 5;
  return version >= 5.5;
}
