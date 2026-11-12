/** Map the tool uses in `assistant` rows and the tool results in `user` rows of one transcript to ToolCalls. */
import type { ToolCall } from "@quantext/shared";
import { blockHash, toolSource } from "./blocks.ts";
import { arr, obj, str } from "./json.ts";
import type { Row } from "./rows.ts";

interface Result {
  ts: string | undefined;
  isError: boolean;
  hash: string;
}

/** The ToolCalls of a transcript, in log order. A result links only when its Block is in `sentBlocks`. */
export function toolCallsOf(rows: readonly Row[], sessionId: string, sentBlocks: ReadonlySet<string>): ToolCall[] {
  const results = new Map<string, Result>();
  const perMessage = new Map<string, number>();
  for (const row of rows) {
    const message = obj(row.data.message);
    for (const raw of arr(message?.content) ?? []) {
      const block = obj(raw);
      if (row.type === "assistant" && block?.type === "tool_use") {
        const id = str(message?.id) ?? "";
        perMessage.set(id, (perMessage.get(id) ?? 0) + 1);
      }
      const useId = str(block?.tool_use_id);
      if (row.type === "user" && block?.type === "tool_result" && useId !== undefined) {
        results.set(useId, {
          ts: str(row.data.timestamp),
          isError: block.is_error === true,
          hash: blockHash("user", raw),
        });
      }
    }
  }
  const toolCalls: ToolCall[] = [];
  for (const row of rows) {
    if (row.type !== "assistant") continue;
    const message = obj(row.data.message);
    for (const raw of arr(message?.content) ?? []) {
      const block = obj(raw);
      if (block?.type !== "tool_use") continue;
      const id = str(block.id) ?? "";
      const name = str(block.name) ?? "";
      const input = block.input ?? null;
      const toolCall: ToolCall = {
        id,
        sessionId,
        callId: str(row.data.requestRef) ?? "",
        name,
        input,
        source: toolSource(name, obj(input)),
        isError: false,
        parallel: perMessage.get(str(message?.id) ?? "") ?? 1,
      };
      const result = results.get(id);
      if (result !== undefined) {
        toolCall.isError = result.isError;
        if (sentBlocks.has(result.hash)) toolCall.resultBlockHash = result.hash;
        const ms = elapsed(str(row.data.timestamp), result.ts);
        if (ms !== undefined) toolCall.durationMs = ms;
      }
      toolCalls.push(toolCall);
    }
  }
  return toolCalls;
}

function elapsed(from: string | undefined, to: string | undefined): number | undefined {
  if (from === undefined || to === undefined) return undefined;
  const ms = Date.parse(to) - Date.parse(from);
  return Number.isNaN(ms) ? undefined : ms;
}
