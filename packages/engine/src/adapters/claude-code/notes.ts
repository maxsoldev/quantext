/** What the transcript tells about content beyond the request itself: compaction summaries and skill texts. */
import type { JsonObject } from "./json.ts";
import { arr, obj, str } from "./json.ts";
import type { Row } from "./rows.ts";

export interface ContentNotes {
  /** Texts of compaction summaries. */
  summaries: Set<string>;
  /** Skill texts, by text, with the skill's name. */
  skills: Map<string, string>;
}

/** Collect the notes from the rows of all transcripts of a session. */
export function contentNotes(rows: readonly Row[]): ContentNotes {
  const notes: ContentNotes = { summaries: new Set(), skills: new Map() };
  const toolUses = new Map<string, JsonObject>();
  for (const row of rows) {
    const message = obj(row.data.message);
    if (row.type === "assistant") {
      for (const block of arr(message?.content) ?? []) {
        const id = str(obj(block)?.id);
        if (obj(block)?.type === "tool_use" && id !== undefined) toolUses.set(id, obj(block) ?? {});
      }
    }
    if (row.type !== "user") continue;
    if (row.data.isCompactSummary === true) for (const text of textsOf(message)) notes.summaries.add(text);
    const toolUse = toolUses.get(str(row.data.sourceToolUseID) ?? "");
    const skill = str(obj(toolUse?.input)?.skill);
    if (row.data.isMeta === true && toolUse?.name === "Skill" && skill !== undefined) {
      for (const text of textsOf(message)) notes.skills.set(text, skill);
    }
  }
  return notes;
}

function textsOf(message: JsonObject | undefined): string[] {
  const content = message?.content;
  if (typeof content === "string") return [content];
  return (arr(content) ?? []).flatMap((block) => str(obj(block)?.text) ?? []);
}
