/**
 * Index every message a `tail` hash may name, by Claude Code's hash rules: an `api-request-blob` row; a `user` row
 * (role and content, a string prompt also as one text block); a run of adjacent `user` rows joined into one
 * message; and an assistant message, which is every `assistant` row of one `message.id`, in order.
 */
import { sha256Sorted } from "./hash.ts";
import type { Json } from "./json.ts";
import { arr, obj, str } from "./json.ts";
import type { WireMessage } from "./rebuild.ts";
import type { Row } from "./rows.ts";

export function wireMessages(rows: readonly Row[]): Map<string, WireMessage> {
  const index = new Map<string, WireMessage>();
  const add = (role: string, content: Json[], hashed: Json = content) =>
    index.set(sha256Sorted({ role, content: hashed }), { role, content });
  const assistant = new Map<string, Json[]>();
  let userRun: Json[][] = [];
  for (const row of rows) {
    const message = obj(row.data.message);
    if (row.type === "api-request-blob" && message !== undefined) {
      const hash = str(row.data.hash);
      if (hash !== undefined) index.set(hash, { role: str(message.role) ?? "", content: blocksOf(message.content) });
    }
    if (row.type === "assistant") {
      userRun = [];
      const id = str(message?.id);
      if (id !== undefined) assistant.set(id, [...(assistant.get(id) ?? []), ...(arr(message?.content) ?? [])]);
    }
    if (row.type === "user" && message !== undefined) {
      const content = blocksOf(message.content);
      add("user", content, message.content ?? null);
      add("user", content);
      userRun.push(content);
      for (let start = 0; start < userRun.length - 1; start++) add("user", userRun.slice(start).flat());
    }
  }
  for (const content of assistant.values()) add("assistant", content);
  return index;
}

/** Message content as blocks: a string is one text block. */
function blocksOf(content: Json | undefined): Json[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return arr(content) ?? [];
}
