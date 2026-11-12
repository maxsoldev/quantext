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
]);
const KNOWN_SYSTEM_SUBTYPES = new Set(["compact_boundary"]);

/** The known rows of one transcript, in order; unknown and unreadable rows are added to `report`. */
export function readRows(name: string, text: string, report: IngestReport): Row[] {
  const rows: Row[] = [];
  text.split("\n").forEach((line, index) => {
    if (line.trim() === "") return;
    const at = `${name}:${index + 1}`;
    const data = parseLine(line);
    if (typeof data === "string") {
      report.unreadable.push({ at, reason: data });
      return;
    }
    const kind = kindOf(data);
    if (kind === undefined) {
      report.unreadable.push({ at, reason: "row has no type" });
    } else if (isKnown(kind)) {
      rows.push({ at, type: kind, data });
    } else {
      report.unknownRecords[kind] = (report.unknownRecords[kind] ?? 0) + 1;
    }
  });
  return rows;
}

function parseLine(line: string): JsonObject | string {
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
