/** Pure helpers for the Output section: stop reasons in words, a tool call's input in short. */
import type { JsonValue } from "@quantext/shared";
import { inputSummary } from "../tools/model.ts";

const STOP: Record<string, string> = {
  end_turn: "It ended its turn.",
  tool_use: "It stopped to run tools.",
  max_tokens: "It hit its output limit: the answer is cut off.",
  stop_sequence: "It reached a stop sequence.",
  pause_turn: "It paused a long turn, to go on in the next call.",
  refusal: "It refused to answer.",
};

/** Why the model stopped, in words (the provider's reason as it is when it is not known here). */
export function stopWords(reason: string): string {
  return STOP[reason] ?? `It stopped: ${reason}.`;
}

/** A tool call's preview (`Name {input}`) without the name. */
export function toolInput(name: string, preview: string): string {
  return preview.startsWith(`${name} `) ? preview.slice(name.length + 1) : preview;
}

const KEYS = ["command", "file_path", "notebook_path", "pattern", "url", "query", "description", "skill"];

/**
 * A tool call's input in words (the command, the file, …) from its preview, as on the tool calls page. The preview
 * may be cut inside its JSON, so a whole one is read as JSON and a cut one by its first known key.
 */
export function toolWords(name: string, preview: string, cwd?: string): string {
  const raw = toolInput(name, preview);
  try {
    return inputSummary(name, JSON.parse(raw) as JsonValue, cwd);
  } catch {
    // A cut preview: find the first known key below.
  }
  for (const key of KEYS) {
    const m = new RegExp(`"${key}":"((?:[^"\\\\]|\\\\.)*)"`).exec(raw);
    if (m?.[1] === undefined) continue;
    return inputSummary(name, { [key]: JSON.parse(`"${m[1]}"`) as string }, cwd);
  }
  return raw;
}
