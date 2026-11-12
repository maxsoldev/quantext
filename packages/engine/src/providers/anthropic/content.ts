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
