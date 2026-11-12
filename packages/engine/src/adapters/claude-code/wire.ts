/**
 * The messages a `tail` hash may name, by Claude Code's hash rules: an `api-request-blob` row; a `user` row (role
 * and content, a string prompt also as one text block); an assistant message, which is every `assistant` row of one
 * `message.id`, in order; and a run of adjacent `user` rows joined into one message, found only when a tail asks
 * for a hash that nothing else gives (so each run is hashed once per miss, not on every row).
 */
import { sha256Sorted } from "./hash.ts";
import type { Json, JsonObject } from "./json.ts";
import { arr, obj, str } from "./json.ts";
import type { Content } from "./lookup.ts";
import { get, put } from "./records.ts";
import type { TranscriptState, WireMessage } from "./state.ts";

/** Assistant messages whose rows may still come, per transcript; older ones are closed. */
const MAX_OPEN_ASSISTANT = 8;
/** User rows the API may join into one message; a longer run keeps only its last rows. */
const MAX_USER_RUN = 16;

export function wireHash(role: string, content: Json): string {
  return sha256Sorted({ role, content });
}

export function addBlob(store: Content, data: JsonObject): void {
  const hash = str(data.hash);
  const message = obj(data.message);
  if (hash === undefined || message === undefined) return;
  store.putMessage(hash, { role: str(message.role) ?? "", content: blocksOf(message.content) });
}

export function addUserRow(store: Content, transcript: TranscriptState, message: JsonObject): void {
  const content = blocksOf(message.content);
  const role = str(message.role) ?? "user";
  store.putMessage(wireHash(role, message.content ?? null), { role, content });
  if (typeof message.content === "string") store.putMessage(wireHash(role, content), { role, content });
  transcript.userRun.push(content);
  if (transcript.userRun.length > MAX_USER_RUN) transcript.userRun.shift();
}

/** Add one row of an assistant message; returns the hash of the message so far. */
export function addAssistantRow(store: Content, transcript: TranscriptState, message: JsonObject): string | undefined {
  transcript.userRun = [];
  const id = str(message.id);
  if (id === undefined) return undefined;
  const known = get(store.state.assistantHashes, id);
  const before = get(store.state.assistant, id) ?? (known === undefined ? undefined : store.message(known)?.content);
  const content = [...(before ?? []), ...(arr(message.content) ?? [])];
  transcript.openAssistantIds = [...transcript.openAssistantIds.filter((open) => open !== id), id];
  while (transcript.openAssistantIds.length > MAX_OPEN_ASSISTANT) {
    const done = transcript.openAssistantIds.shift() ?? "";
    delete store.state.assistant[done]; // its rows are long done: only its hash is needed now
    delete store.state.assistantHashes[done];
  }
  put(store.state.assistant, id, content);
  const hash = wireHash("assistant", content);
  put(store.state.assistantHashes, id, hash);
  store.putMessage(hash, { role: "assistant", content });
  return hash;
}

/** The message a tail hash names; joins the transcript's current run of user rows when nothing else matches. */
export function resolve(store: Content, transcript: TranscriptState, hash: string): WireMessage | undefined {
  const known = store.message(hash);
  if (known !== undefined) return known;
  const run = transcript.userRun;
  for (let start = 0; start < run.length - 1; start++) {
    const content = run.slice(start).flat();
    if (wireHash("user", content) === hash) return store.putMessage(hash, { role: "user", content });
  }
  return undefined;
}

/** Message content as blocks: a string is one text block. */
export function blocksOf(content: Json | undefined): Json[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return arr(content) ?? [];
}
