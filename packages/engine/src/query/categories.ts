/** The context bar's groups: what each Block kind counts as. */
import type { BlockKind, BlockSource, ContextCategory } from "@quantext/shared";

export const CATEGORIES: readonly ContextCategory[] = [
  "tool-definitions",
  "base-instructions",
  "injected-context",
  "user",
  "assistant",
  "reasoning",
  "tool-calls",
  "tool-outputs",
  "compaction-summary",
  "other",
];

/** The group of a Block: an image or document counts as a tool output when a tool gave it, else as the user's. */
export function categoryOf(kind: BlockKind | "framing", source: BlockSource): ContextCategory {
  switch (kind) {
    case "tool-schema":
      return "tool-definitions";
    case "system":
      return "base-instructions";
    case "reminder":
      return "injected-context";
    case "user":
      return "user";
    case "assistant":
      return "assistant";
    case "reasoning":
      return "reasoning";
    case "tool-call":
      return "tool-calls";
    case "tool-result":
      return "tool-outputs";
    case "image":
    case "document":
      return source.tool === undefined ? "user" : "tool-outputs";
    case "summary":
      return "compaction-summary";
    default:
      return "other";
  }
}

/** Every group at 0 tokens. */
export function emptyCategories(): Record<ContextCategory, number> {
  return Object.fromEntries(CATEGORIES.map((c) => [c, 0])) as Record<ContextCategory, number>;
}
