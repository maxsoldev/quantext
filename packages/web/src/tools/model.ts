/** A Session's tool calls joined with their outputs' lifetimes, in an order, and an Edit's change line by line. */
import type { JsonValue, Lifetime, ToolCallSummary, ToolOutput } from "@quantext/shared";
import type { ToolSort } from "../route.ts";

export interface ToolRow {
  call: ToolCallSummary;
  /** Its result's lifetime: absent when no Call holds the result. */
  lifetime?: Lifetime & { firstCall?: number; lastCall?: number };
}

export function toolRows(calls: readonly ToolCallSummary[], outputs: readonly ToolOutput[], sort: ToolSort): ToolRow[] {
  const byId = new Map(outputs.map((o) => [o.toolUseId, o]));
  const rows = calls.map((call): ToolRow => {
    const lifetime = byId.get(call.id);
    return lifetime ? { call, lifetime } : { call };
  });
  const key: (r: ToolRow) => number =
    sort === "cost"
      ? (r) => -(r.lifetime?.costUsd.total ?? -1)
      : sort === "tokens"
        ? (r) => -(r.call.resultTokens ?? -1)
        : sort === "calls"
          ? (r) => -(r.lifetime?.calls ?? -1)
          : () => 0;
  const order = (r: ToolRow) => r.call.callIndex ?? Number.MAX_SAFE_INTEGER;
  return rows.sort((a, b) => key(a) - key(b) || order(a) - order(b));
}

const obj = (v: JsonValue): Record<string, JsonValue> =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? v : {};
const str = (v: JsonValue | undefined): string | undefined => (typeof v === "string" ? v : undefined);

/** The input as people read it: the command, the file, the pattern or the task; else short JSON. */
export function inputSummary(name: string, input: JsonValue, cwd?: string): string {
  const i = obj(input);
  const pick =
    str(i.command) ??
    str(i.file_path) ??
    str(i.notebook_path) ??
    (str(i.pattern) && (str(i.path) ? `${str(i.pattern)} in ${str(i.path)}` : str(i.pattern))) ??
    str(i.url) ??
    str(i.query) ??
    (name === "Agent" || name === "Task" ? str(i.description) : undefined) ??
    str(i.skill);
  if (pick === undefined) return JSON.stringify(input).slice(0, 200);
  return cwd && pick.startsWith(`${cwd}/`) ? pick.slice(cwd.length + 1) : pick;
}

export interface DiffLine {
  kind: "same" | "del" | "add" | "gap";
  text: string;
}

/** The change an Edit, MultiEdit or Write made, line by line; undefined for other tools. */
export function editDiff(name: string, input: JsonValue): DiffLine[] | undefined {
  const i = obj(input);
  if (name === "Write" && str(i.content) !== undefined) {
    return (str(i.content) as string).split("\n").map((text) => ({ kind: "add", text }));
  }
  if (name === "Edit" && str(i.old_string) !== undefined && str(i.new_string) !== undefined) {
    return lineDiff(str(i.old_string) as string, str(i.new_string) as string);
  }
  if (name === "MultiEdit" && Array.isArray(i.edits)) {
    return i.edits.flatMap((e, k) => {
      const o = obj(e);
      const lines = lineDiff(str(o.old_string) ?? "", str(o.new_string) ?? "");
      return k === 0 ? lines : [{ kind: "gap" as const, text: "" }, ...lines];
    });
  }
  return undefined;
}

/** A longest-common-subsequence diff of lines; past 400 × 400 lines, all removed then all added. */
function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.split("\n");
  const b = after.split("\n");
  if (a.length * b.length > 160_000) {
    return [...a.map((text) => ({ kind: "del" as const, text })), ...b.map((text) => ({ kind: "add" as const, text }))];
  }
  const w = b.length + 1;
  const lcs = new Uint32Array((a.length + 1) * w);
  for (let x = a.length - 1; x >= 0; x--) {
    for (let y = b.length - 1; y >= 0; y--) {
      lcs[x * w + y] =
        a[x] === b[y]
          ? (lcs[(x + 1) * w + y + 1] ?? 0) + 1
          : Math.max(lcs[(x + 1) * w + y] ?? 0, lcs[x * w + y + 1] ?? 0);
    }
  }
  const out: DiffLine[] = [];
  let x = 0;
  let y = 0;
  while (x < a.length || y < b.length) {
    if (x < a.length && y < b.length && a[x] === b[y]) {
      out.push({ kind: "same", text: a[x] as string });
      x++;
      y++;
    } else if (y < b.length && (x >= a.length || (lcs[x * w + y + 1] ?? 0) > (lcs[(x + 1) * w + y] ?? 0))) {
      out.push({ kind: "add", text: b[y] as string });
      y++;
    } else {
      out.push({ kind: "del", text: a[x] as string });
      x++;
    }
  }
  return out;
}
