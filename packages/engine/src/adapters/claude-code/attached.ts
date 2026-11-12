/**
 * Texts Claude Code attached to a request (attachment rows), and where they are in a Block's text. The harness
 * sends an attached text as logged, or without its `<system-reminder>` wrapper, and may merge several of them into
 * one text block, joined by blank lines.
 */
import type { BlockPart, BlockSource } from "@quantext/shared";

/** One rendered text of an attachment row. */
export interface Attached {
  type: string;
  path?: string;
  /** The rendered text, as logged. */
  text: string;
  /** The transcript of the row, and whether a request of that transcript was checked for it. */
  transcript: string;
  checked?: 1;
}

/** Attachment types that Claude Code logs before a request but often does not send in it (seen on real logs). */
export const OFTEN_UNSENT: ReadonlySet<string> = new Set(["total_tokens_reminder"]);

const WRAPPED = /^<system-reminder>\n([\s\S]*)\n<\/system-reminder>$/;

/** The forms in which an attached text can be sent: as logged, then without its wrapper. */
export function sentForms(text: string): string[] {
  const trimmed = text.trim();
  const inner = WRAPPED.exec(trimmed)?.[1];
  return inner === undefined || inner.trim() === "" ? [trimmed] : [trimmed, inner];
}

/** Whether a text holds one of the forms of an attached text. */
export function holds(text: string, attached: Attached): boolean {
  return sentForms(attached.text).some((form) => form !== "" && text.includes(form));
}

const LABELS: Record<string, string> = {
  agent_listing_delta: "Agent listing",
  auto_mode: "Auto mode",
  date: "Date",
  deferred_tools_delta: "Deferred tools",
  diagnostics: "Diagnostics",
  directory: "Directory",
  edited_text_file: "Edited file",
  environment: "Environment",
  file: "File",
  mcp_instructions_delta: "MCP instructions",
  model: "Model",
  plan_mode: "Plan mode",
  queued_command: "Queued command",
  session_context: "Session context",
  silent_turn_reminder: "Turn reminder",
  skill_listing: "Skill listing",
  total_tokens_reminder: "Token reminder",
};

/** A short name for people; a type not listed reads as its words ("todo_reminder": "Todo reminder"). */
export function labelOf(type: string): string {
  const known = Object.hasOwn(LABELS, type) ? LABELS[type] : undefined;
  if (known !== undefined) return known;
  const words = type
    .replace(/_delta$/, "")
    .replaceAll("_", " ")
    .trim();
  return words === "" ? "Attachment" : words[0]?.toUpperCase() + words.slice(1);
}

export const LEFTOVER_LABEL = "Other text";

/** The source a part of an attached text gets. */
export function sourceOf(attached: Attached): BlockSource {
  return attached.path === undefined
    ? { attachment: attached.type }
    : { attachment: attached.type, filePath: attached.path };
}

interface Span {
  start: number;
  end: number;
  attached: Attached;
}

/**
 * The parts of `text`: each attached text found in it as a substring (in the order given, each at its first place
 * not taken yet), and the text between them that none accounts for. Blank space between two spans joins the span
 * before it, so the parts cover `text` end to end. Undefined when no attached text is in it.
 */
export function partsOf(text: string, attached: readonly Attached[]): { parts: BlockPart[] } | undefined {
  const spans: Span[] = [];
  const free = (start: number, end: number) => spans.every((s) => end <= s.start || start >= s.end);
  for (const a of attached) {
    for (const form of sentForms(a.text)) {
      if (form === "") continue;
      let at = text.indexOf(form);
      while (at >= 0 && !free(at, at + form.length)) at = text.indexOf(form, at + 1);
      if (at >= 0) {
        spans.push({ start: at, end: at + form.length, attached: a });
        break;
      }
    }
  }
  if (spans.length === 0) return undefined;
  spans.sort((a, b) => a.start - b.start);
  const parts: BlockPart[] = [];
  const leftover = (start: number, end: number) => {
    const last = parts.at(-1);
    const lead = text.slice(start, end).search(/\S/);
    if (lead < 0) {
      if (last !== undefined) last.end = end; // blank space joins the part before (or, at the start, the first)
    } else {
      if (last !== undefined) last.end = start + lead;
      const from = last === undefined ? start : start + lead;
      parts.push({ start: from, end, label: LEFTOVER_LABEL, source: {} });
    }
  };
  let at = 0;
  for (const s of spans) {
    if (s.start > at) leftover(at, s.start);
    parts.push({ start: s.start, end: s.end, label: labelOf(s.attached.type), source: sourceOf(s.attached) });
    at = s.end;
  }
  if (at < text.length) leftover(at, text.length);
  if (parts[0] !== undefined && parts[0].start > 0) parts[0].start = 0; // blank space before the first span
  return { parts };
}

/** Attached texts kept for later Blocks, newest last: at most so many, and so many characters in all. */
const MAX_ATTACHED = 64;
const MAX_ATTACHED_CHARS = 256 * 1024;

/** `attached` with `added` as the newest (an equal older text goes), cut to the bounds from the oldest. */
export function remember(attached: readonly Attached[], added: Attached): Attached[] {
  const out = [...attached.filter((a) => a.text.trim() !== added.text.trim()), added].slice(-MAX_ATTACHED);
  let chars = out.reduce((sum, a) => sum + a.text.length, 0);
  while (out.length > 1 && chars > MAX_ATTACHED_CHARS) chars -= out.shift()?.text.length ?? 0;
  return out;
}
