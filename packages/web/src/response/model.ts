/** Pure helpers for the Response card: a reply's text as text and code segments, stop reasons in words. */
import type { JsonValue } from "@quantext/shared";
import { inputSummary } from "../tools/model.ts";

export type Segment = { kind: "text"; text: string } | { kind: "code"; text: string; lang?: string };

const FENCE = /^ {0,3}```\s*([\w+-]*)\s*$/;

/**
 * A reply's text split at fenced code blocks (```), so code shows monospaced and the rest as plain text with its
 * line breaks. Nothing is parsed as HTML or Markdown beyond the fences. An unclosed fence runs to the end.
 */
export function segments(text: string): Segment[] {
  const out: Segment[] = [];
  let lines: string[] = [];
  let code: { lang: string } | undefined;
  const flush = () => {
    const body = lines.join("\n");
    lines = [];
    if (code !== undefined) {
      out.push(code.lang ? { kind: "code", text: body, lang: code.lang } : { kind: "code", text: body });
    } else if (body.trim() !== "") out.push({ kind: "text", text: body.replace(/^\n+|\n+$/g, "") });
  };
  for (const line of text.split("\n")) {
    const fence = FENCE.exec(line);
    if (fence === null) {
      lines.push(line);
      continue;
    }
    flush();
    code = code === undefined ? { lang: fence[1] ?? "" } : undefined;
  }
  flush();
  return out;
}

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
