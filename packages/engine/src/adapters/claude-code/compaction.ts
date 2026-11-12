/**
 * Compactions, and the Call that wrote each summary. That Call has no `api-request` or `assistant` row: its usage is
 * derived from the change of the running `cost-state` totals over the `compact_boundary`, minus the Calls logged in
 * between, and checked against the context size before the compaction.
 */
import type { Call, Compaction, Usage } from "@quantext/shared";
import { canonicalModel, priceCall } from "../../providers/anthropic/pricing.ts";
import type { JsonObject } from "./json.ts";
import { arr, num, obj, str } from "./json.ts";
import type { WireRequest } from "./rebuild.ts";
import type { Row } from "./rows.ts";

export interface SummaryCall {
  call: Call;
  /** The context the summary was written from; never complete, as the summarising prompt is not logged. */
  request: WireRequest | undefined;
  /** The row index of the compaction, to place the Call in log order. */
  at: number;
}

export function compactionsOf(
  rows: readonly Row[],
  sessionId: string,
  calls: readonly Call[],
  requests: ReadonlyMap<string, WireRequest>,
): { compactions: Compaction[]; summaries: SummaryCall[] } {
  const compactions: Compaction[] = [];
  const summaries: SummaryCall[] = [];
  rows.forEach((row, at) => {
    if (row.type !== "system/compact_boundary") return;
    const id = str(row.data.uuid) ?? row.at;
    const meta = obj(row.data.compactMetadata);
    const compaction: Compaction = {
      id,
      sessionId,
      ts: str(row.data.timestamp) ?? "",
      trigger: str(meta?.trigger) ?? "",
    };
    const before = num(meta?.preTokens);
    const after = num(meta?.postTokens);
    if (before !== undefined) compaction.beforeTokens = before;
    if (after !== undefined) compaction.afterTokens = after;
    const derived = derivedUsage(rows, at, calls);
    if (derived !== undefined) {
      const previous = lastCallBefore(rows, at, calls);
      const call = summaryCall(`${id}:summary`, sessionId, compaction.ts, derived, previous, before);
      compaction.summaryCallId = call.id;
      summaries.push({ call, request: previous && contextOf(rows, previous, requests), at });
    }
    compactions.push(compaction);
  });
  return { compactions, summaries };
}

function summaryCall(
  id: string,
  sessionId: string,
  ts: string,
  derived: Derived,
  previous?: Call,
  before?: number,
): Call {
  const detail = "the summarising request is not in the log, only its derived usage";
  const call: Call = {
    id,
    sessionId,
    index: 0,
    ts,
    model: derived.model,
    params: {},
    usage: derived.usage,
    framingTokens: 0,
    issues: [{ kind: "unresolved-request", detail }],
  };
  const canonical = canonicalModel(derived.model);
  if (canonical !== undefined) call.canonicalModel = canonical;
  const { cost, issues } = priceCall(derived.usage, { model: derived.model });
  if (cost !== undefined) call.cost = cost;
  call.issues.push(...issues);
  if (previous?.shapeHash !== undefined) call.shapeHash = previous.shapeHash;
  const input = derived.usage.inputTokens + derived.usage.cacheReadTokens + derived.usage.cacheWriteTokens;
  if (before !== undefined && input < before) {
    const reason = `derived input ${input} is less than the ${before} tokens of context before the compaction`;
    call.issues.push({ kind: "unreconciled-tokens", detail: reason });
  }
  return call;
}

interface Derived {
  model: string;
  usage: Usage;
}

const COUNTERS = {
  inputTokens: "inputTokens",
  cacheReadTokens: "cacheReadInputTokens",
  cacheWriteTokens: "cacheCreationInputTokens",
  cacheWrite5mTokens: "cacheCreationEphemeral5mInputTokens",
  cacheWrite1hTokens: "cacheCreationEphemeral1hInputTokens",
  outputTokens: "outputTokens",
} as const;

/** The usage of the summarising Call: the one model whose running totals changed more than its logged Calls. */
function derivedUsage(rows: readonly Row[], at: number, calls: readonly Call[]): Derived | undefined {
  const beforeAt = rows.findLastIndex((row, i) => i < at && row.type === "cost-state");
  const afterAt = rows.findIndex((row, i) => i > at && row.type === "cost-state");
  if (beforeAt < 0 || afterAt < 0) return undefined;
  const totalsBefore = obj(rows[beforeAt]?.data.modelUsage) ?? {};
  const totalsAfter = obj(rows[afterAt]?.data.modelUsage) ?? {};
  const between = new Set(rows.slice(beforeAt, afterAt).flatMap((row) => str(row.data.id) ?? []));
  const logged = calls.filter((call) => between.has(call.id));
  const changed = Object.keys(totalsAfter).flatMap((model) => {
    const usage = delta(obj(totalsAfter[model]) ?? {}, obj(totalsBefore[model]) ?? {});
    for (const call of logged.filter((c) => c.canonicalModel === canonicalModel(model))) subtract(usage, call.usage);
    const any = Object.values(usage).some((v) => typeof v === "number" && v !== 0);
    return any ? [{ model: model.replace(/\[[^\]]*\]$/, ""), usage }] : [];
  });
  return changed.length === 1 ? changed[0] : undefined;
}

function delta(after: JsonObject, before: JsonObject): Usage {
  const d = (key: string) => (num(after[key]) ?? 0) - (num(before[key]) ?? 0);
  const usage: Usage = { basis: "derived", inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 };
  for (const [field, key] of Object.entries(COUNTERS)) {
    // A counter missing on either side stays unknown (a time-to-live split), not 0.
    if (after[key] !== undefined && before[key] !== undefined) usage[field as keyof typeof COUNTERS] = d(key);
  }
  return usage;
}

function subtract(usage: Usage, logged: Usage | undefined): void {
  if (logged === undefined) return;
  for (const field of Object.keys(COUNTERS) as (keyof typeof COUNTERS)[]) {
    if (usage[field] !== undefined) usage[field] = (usage[field] ?? 0) - (logged[field] ?? 0);
  }
}

function lastCallBefore(rows: readonly Row[], at: number, calls: readonly Call[]): Call | undefined {
  const ids = new Set(rows.slice(0, at).flatMap((row) => (row.type === "api-request" ? (str(row.data.id) ?? []) : [])));
  return calls.findLast((call) => ids.has(call.id));
}

/** The previous Call's request and its response: the context the summary was written from. */
function contextOf(
  rows: readonly Row[],
  previous: Call,
  requests: ReadonlyMap<string, WireRequest>,
): WireRequest | undefined {
  const request = requests.get(previous.id);
  if (request === undefined) return undefined;
  const response = rows
    .filter((row) => row.type === "assistant" && str(row.data.requestRef) === previous.id)
    .flatMap((row) => arr(obj(row.data.message)?.content) ?? []);
  const messages =
    response.length > 0 ? [...request.messages, { role: "assistant", content: response }] : request.messages;
  return { ...request, messages, missing: ["the summarising prompt is not in the log"] };
}
