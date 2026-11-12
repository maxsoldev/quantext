/** Block kinds and request sections in words, with what each means. */
import type { BlockKind, RequestSection } from "@quantext/shared";

export const KIND_LABEL: Record<BlockKind | "framing", string> = {
  "tool-schema": "Tool schema",
  system: "System",
  user: "User",
  reminder: "Reminder",
  assistant: "Assistant",
  reasoning: "Reasoning",
  "tool-call": "Tool call",
  "tool-result": "Tool result",
  image: "Image",
  document: "Document",
  summary: "Summary",
  gap: "Gap",
  framing: "Framing",
};

export const KIND_EXPLAIN: Partial<Record<BlockKind | "framing", string>> = {
  reminder: "Text the harness added to a message for the model, not typed by the user.",
  gap: "A message that is not in the log. It takes the tokens the other blocks leave, so the total still adds up.",
  summary: "The text that replaced the context after a compaction.",
  framing: "Input tokens after the last block: the end of the request.",
};

export const SECTION: Record<RequestSection, { title: string; explain: string }> = {
  tools: {
    title: "Tool definitions",
    explain:
      "Sent first, with every request. The model reads each tool's name, description and input schema. You never see these in the chat.",
  },
  system: {
    title: "System prompt",
    explain: "The harness's instructions, sent after the tools and before the first message. Also not in the chat.",
  },
  messages: {
    title: "Messages",
    explain:
      "The conversation as the model receives it: your messages, its replies, tool calls and results, and the text the harness adds.",
  },
};
