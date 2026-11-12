/**
 * The viewer's two ways to split a Call's tokens, each in a fixed order with fixed colours (tokens.css):
 * what the context holds (the context bar's categories, in request order) and how it was billed (cache parts).
 */
import type { ContextCategory } from "@quantext/shared";

export interface Part<K extends string> {
  key: K;
  label: string;
  explain: string;
}

export const CATEGORIES: readonly Part<ContextCategory>[] = [
  {
    key: "tool-definitions",
    label: "Tool definitions",
    explain: "The schemas of the tools the model may call. Sent with every request, before the system prompt.",
  },
  {
    key: "base-instructions",
    label: "System prompt",
    explain: "The harness's own instructions to the model. The user never sees them in the chat.",
  },
  {
    key: "injected-context",
    label: "Injected context",
    explain:
      "Text the harness adds to the messages: CLAUDE.md files, project memory, the environment, git status, " +
      "reminders, attached files, skill listings.",
  },
  { key: "user", label: "User messages", explain: "What the user typed." },
  { key: "assistant", label: "Assistant text", explain: "The model's earlier replies, sent back as history." },
  { key: "reasoning", label: "Reasoning", explain: "The model's earlier thinking blocks, sent back as history." },
  { key: "tool-calls", label: "Tool calls", explain: "The model's earlier tool uses: the tool and its input." },
  {
    key: "tool-outputs",
    label: "Tool outputs",
    explain: "What the tools gave back: file contents, command output, search results.",
  },
  {
    key: "compaction-summary",
    label: "Compaction summary",
    explain: "The summary that replaced the earlier context after a compaction.",
  },
  { key: "other", label: "Other", explain: "Images, documents, and input the log does not show (gaps), plus framing." },
];

export type CachePart = "cacheRead" | "cacheWrite" | "input" | "output";

/** Bottom to top in the cache chart: the cheap reused part first, then what this Call paid for in full. */
export const CACHE_PARTS: readonly Part<CachePart>[] = [
  {
    key: "cacheRead",
    label: "Cache read",
    explain:
      "Input read from the provider's cache: the prefix this request shares with the previous one. 0.05× to 0.1× of the input price, by model.",
  },
  {
    key: "cacheWrite",
    label: "Cache write",
    explain:
      "Input written to the cache for the next request to read. About 1.25× the input price (2× for a one-hour cache).",
  },
  {
    key: "input",
    label: "Uncached input",
    explain: "Input neither read from nor written to the cache, at the full input price.",
  },
  {
    key: "output",
    label: "Output",
    explain: "Tokens the model wrote: text, tool calls and reasoning. The highest price per token.",
  },
];

export const CATEGORY_LABEL = Object.fromEntries(CATEGORIES.map((c) => [c.key, c.label])) as Record<
  ContextCategory,
  string
>;
