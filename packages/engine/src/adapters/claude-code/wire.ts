/**
 * The messages a `tail` hash may name, by Claude Code's hash rules: an `api-request-blob` row; a `user` row (role
 * and content, a string prompt also as one text block); an assistant message, which is every `assistant` row of one
 * `message.id`, in order; and a run of adjacent `user` rows joined into one message, found only when a tail asks
 * for a hash that nothing else gives (so each run is hashed once per miss, not on every row).
 */
import { sha256Sorted } from "./hash.ts";
import type { Json, JsonObject } from "./json.ts";
import { arr, obj, str } from "./json.ts";
import { get, put } from "./records.ts";
import type { ParserState, TranscriptState, WireMessage } from "./state.ts";

export function wireHash(role: string, content: Json): string {
  return sha256Sorted({ role, content });
}

export function addBlob(state: ParserState, data: JsonObject): void {
  const hash = str(data.hash);
  const message = obj(data.message);
  if (hash === undefined || message === undefined) return;
  put(state.messages, hash, { role: str(message.role) ?? "", content: blocksOf(message.content) });
}

export function addUserRow(state: ParserState, transcript: TranscriptState, message: JsonObject): void {
  const content = blocksOf(message.content);
  const role = str(message.role) ?? "user";
  put(state.messages, wireHash(role, message.content ?? null), { role, content });
  if (typeof message.content === "string") put(state.messages, wireHash(role, content), { role, content });
  transcript.userRun.push(content);
}

export function addAssistantRow(state: ParserState, transcript: TranscriptState, message: JsonObject): void {
  transcript.userRun = [];
  const id = str(message.id);
  if (id === undefined) return;
  const content = [...(get(state.assistant, id) ?? []), ...(arr(message.content) ?? [])];
  put(state.assistant, id, content);
  put(state.messages, wireHash("assistant", content), { role: "assistant", content });
}

/** The message a tail hash names; joins the transcript's current run of user rows when nothing else matches. */
export function resolve(state: ParserState, transcript: TranscriptState, hash: string): WireMessage | undefined {
  const known = get(state.messages, hash);
  if (known !== undefined) return known;
  const run = transcript.userRun;
  for (let start = 0; start < run.length - 1; start++) {
    const content = run.slice(start).flat();
    if (wireHash("user", content) === hash) return put(state.messages, hash, { role: "user", content });
  }
  return undefined;
}

/** Message content as blocks: a string is one text block. */
export function blocksOf(content: Json | undefined): Json[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return arr(content) ?? [];
}
