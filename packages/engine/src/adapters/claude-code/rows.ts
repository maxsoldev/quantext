/** Split a Claude Code JSONL transcript into rows, and sort out the row types this adapter does not know. */
import type { IngestReport } from "@quantext/shared";
import type { JsonObject } from "./json.ts";
import { isObject, str } from "./json.ts";

export interface Row {
  /** Where the row is: transcript name and 1-based line. */
  at: string;
  type: string;
  data: JsonObject;
}

/**
 * Row types the adapter reads, or knows it does not need (UI and process state of the harness). Every other type
 * is counted as unknown. A `system` row is known only by its subtype.
 */
const KNOWN_TYPES = new Set([
  "api-request",
  "api-request-blob",
  "api-request-shape",
  "assistant",
  "user",
  "attachment",
  "cost-state",
  "atis-latch",
  "last-prompt",
  "queue-operation",
  "tools-used",
  "mode",
  "ai-title",
  "custom-title",
  "agent-name",
  "pr-link",
  "continued-in",
  "fork-context-ref",
  "relocated",
  "permission-mode",
  "dev-mods",
  "started",
  "result",
  "launched",
  "file-history-snapshot",
  "file-history-delta",
  "worktree-state",
]);
const KNOWN_SYSTEM_SUBTYPES = new Set([
  "compact_boundary",
  "turn_duration",
  "away_summary",
  "local_command",
  "stop_hook_summary",
  "informational",
  "scheduled_task_fire",
  "agents_killed",
]);

/**
 * The row of one complete line, or undefined for a blank, unknown or unreadable line (counted in `report`, the
 * report of this read).
 */
export function readLine(at: string, line: string, report: IngestReport): Row | undefined {
  if (line.trim() === "") return undefined;
  const data = parseLine(line);
  if (typeof data === "string") {
    report.unreadable.push({ at, reason: data });
    return undefined;
  }
  const kind = kindOf(data);
  if (kind === undefined) {
    report.unreadable.push({ at, reason: "row has no type" });
    return undefined;
  }
  if (isKnown(kind)) return { at, type: kind, data };
  countUnknown(report, kind);
  return undefined;
}

/** Add one to the count of an unknown record kind. Any string is a safe kind, also `__proto__`. */
export function countUnknown(report: IngestReport, kind: string): void {
  addOne(report.unknownRecords, kind);
}

/** Add one to the count of a known record kind that holds nothing for the domain. */
export function countIgnored(report: IngestReport, kind: string): void {
  addOne(report.ignoredRecords, kind);
}

function addOne(counts: { kind: string; count: number }[], kind: string): void {
  const entry = counts.find((e) => e.kind === kind);
  if (entry === undefined) counts.push({ kind, count: 1 });
  else entry.count++;
}

/** Lines longer than this, or nested deeper, are reported as unreadable instead of parsed. */
const MAX_LINE_CHARS = 64 * 1024 * 1024;
const MAX_DEPTH = 256;

function parseLine(line: string): JsonObject | string {
  if (line.length > MAX_LINE_CHARS) return `line is longer than ${MAX_LINE_CHARS} characters`;
  if (nestingDepth(line) > MAX_DEPTH) return `JSON is nested deeper than ${MAX_DEPTH} levels`;
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (error) {
    return `not JSON: ${(error as Error).message}`;
  }
  return isObject(value) ? value : "not a JSON object";
}

/** The row type, with the subtype for `system` rows (`system/compact_boundary`). */
function kindOf(data: JsonObject): string | undefined {
  const type = str(data.type);
  if (type !== "system") return type;
  return `system/${str(data.subtype) ?? "?"}`;
}

function isKnown(kind: string): boolean {
  if (kind.startsWith("system/")) return KNOWN_SYSTEM_SUBTYPES.has(kind.slice("system/".length));
  return KNOWN_TYPES.has(kind);
}

/** The deepest bracket nesting of a JSON text, outside strings. Stops counting once past the limit. */
function nestingDepth(text: string): number {
  let depth = 0;
  let max = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (inString) {
      if (c === 92)
        i++; // backslash: skip the escaped character
      else if (c === 34) inString = false;
    } else if (c === 34) inString = true;
    else if (c === 91 || c === 123) {
      if (++depth > max) max = depth;
      if (max > MAX_DEPTH) return max;
    } else if (c === 93 || c === 125) depth--;
  }
  return max;
}
