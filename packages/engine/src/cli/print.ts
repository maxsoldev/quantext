/** The human output of each `qx` command, from the query layer's results. */
import type {
  CallContext,
  ContextDiff,
  Page,
  QueryReport,
  SessionDetail,
  SessionSummary,
  SqlResult,
} from "@quantext/shared";
import { CATEGORIES } from "../query/index.ts";
import type { Column } from "./format.ts";
import { bytes, count, percent, table, time, usd } from "./format.ts";

export function printSessions(page: Page<SessionSummary>): string {
  const rows = page.items.flatMap((s) => [{ s, depth: 0 }, ...(s.subagents ?? []).map((a) => ({ s: a, depth: 1 }))]);
  const columns: Column<(typeof rows)[number]>[] = [
    {
      title: "SESSION",
      value: ({ s, depth }) => (depth > 0 ? `└ ${s.agentName ?? s.id.slice(s.id.lastIndexOf(":") + 1)}` : s.id),
    },
    { title: "ENDED", value: ({ s }) => time(s.ended) },
    { title: "CALLS", value: ({ s }) => String(s.calls), right: true },
    { title: "COST", value: ({ s }) => usd(s.cost.totalUsd), right: true },
    { title: "MAX CTX", value: ({ s }) => count(s.maxContextTokens), right: true },
    { title: "CACHE", value: ({ s }) => percent(s.cacheHitRate), right: true },
    { title: "FLAGS", value: ({ s }) => flags(s) },
    { title: "TITLE / PROJECT", value: ({ s }) => s.title ?? s.agentName ?? s.project ?? "", max: 60 },
  ];
  const shown = `${page.items.length === 0 ? 0 : page.offset + 1}-${page.offset + page.items.length} of ${page.total}`;
  return `${table(rows, columns)}\n\n${shown} sessions\n`;
}

function flags(s: SessionSummary): string {
  const out: string[] = [];
  if (s.live) out.push("live");
  if (s.requestLog !== "present") out.push(`requests:${s.requestLog}`);
  const issues = Object.values(s.issues).reduce((n, k) => n + (k ?? 0), 0);
  if (issues > 0) out.push(`issues:${issues}`);
  if (s.unpricedCalls > 0) out.push(`unpriced:${s.unpricedCalls}`);
  return out.join(" ");
}

export function printSession(d: SessionDetail): string {
  const s = d.session;
  const lines = [
    `${s.title ?? s.id}`,
    `  id ${s.id} (log ${s.log})${s.parentId === undefined ? "" : `, subagent of ${s.parentId}`}`,
    `  project ${s.project ?? "-"}, cwd ${s.cwd ?? "-"}`,
    `  ${time(s.started)} to ${time(s.ended)}${s.live ? " (live)" : ""}, ${s.harness} ${s.harnessVersion ?? ""}`.trimEnd(),
    `  models ${s.models.join(", ") || "-"}; requests ${s.requestLog}`,
    `  ${s.calls} calls, ${usd(s.cost.totalUsd)}: input ${usd(s.cost.inputUsd)}, cache read ${usd(s.cost.cacheReadUsd)},` +
      ` cache write ${usd(s.cost.cacheWriteUsd)}, output ${usd(s.cost.outputUsd)}`,
    `  tokens: input ${count(s.tokens.input)}, cache read ${count(s.tokens.cacheRead)}, cache write ${count(s.tokens.cacheWrite)},` +
      ` output ${count(s.tokens.output)}; max context ${count(s.maxContextTokens)}; cache hit ${percent(s.cacheHitRate)}`,
  ];
  const issues = Object.entries(s.issues).map(([k, n]) => `${k} ${n}`);
  if (issues.length > 0) lines.push(`  issues: ${issues.join(", ")}`);
  lines.push(
    "",
    table(d.lanes, [
      { title: "LANE", value: (l) => l.lane },
      { title: "CALLS", value: (l) => String(l.calls), right: true },
      { title: "FIRST", value: (l) => String(l.firstCall), right: true },
      { title: "LAST", value: (l) => String(l.lastCall), right: true },
    ]),
  );
  if (d.compactions.length > 0) {
    lines.push(
      "",
      table(d.compactions, [
        { title: "COMPACTION", value: (c) => time(c.ts) },
        { title: "TRIGGER", value: (c) => c.trigger },
        { title: "BEFORE", value: (c) => count(c.beforeTokens), right: true },
        { title: "AFTER", value: (c) => count(c.afterTokens), right: true },
        { title: "REMOVED", value: (c) => count(c.removed?.tokens), right: true },
        { title: "KEPT", value: (c) => count(c.kept?.tokens), right: true },
        { title: "SUMMARY", value: (c) => count(c.summaryTokens), right: true },
        { title: "CALLS", value: (c) => `${c.beforeCallIndex ?? "-"} → ${c.afterCallIndex ?? "-"}` },
      ]),
    );
  }
  if (d.events.length > 0) {
    lines.push(
      "",
      table(d.events, [
        { title: "EVENT", value: (e) => time(e.ts) },
        { title: "KIND", value: (e) => e.kind },
        { title: "VALUE", value: (e) => e.value, max: 80 },
      ]),
    );
  }
  if (d.subagents.length > 0) {
    lines.push(
      "",
      table(d.subagents, [
        { title: "SUBAGENT", value: (a) => a.id },
        { title: "AGENT", value: (a) => a.agentName ?? "-" },
        { title: "CALLS", value: (a) => String(a.calls), right: true },
        { title: "COST", value: (a) => usd(a.cost.totalUsd), right: true },
      ]),
    );
  }
  return `${lines.join("\n")}\n`;
}

export function printCall(ctx: CallContext, diff: ContextDiff | undefined): string {
  const c = ctx.call;
  const u = c.usage;
  const head = [
    `call ${c.index} of ${ctx.session.id} (lane ${c.lane}), ${time(c.ts)}, ${c.model}`,
    u === undefined
      ? "  no usage"
      : `  input ${count(ctx.totalTokens)}: cache read ${count(u.cacheReadTokens)}, cache write ${count(u.cacheWriteTokens)},` +
        ` uncached ${count(u.inputTokens)}; output ${count(u.outputTokens)}; cost ${usd(c.cost?.totalUsd)}`,
  ];
  if (c.issues.length > 0) head.push(`  issues: ${c.issues.map((i) => `${i.kind} (${i.detail})`).join("; ")}`);
  if (!ctx.rebuilt)
    return `${head.join("\n")}\n  the log holds no request for this call: its context cannot be shown\n`;
  const body = table(ctx.blocks, [
    { title: "POS", value: (b) => String(b.position), right: true },
    { title: "SECTION", value: (b) => b.section },
    { title: "KIND", value: (b) => (b.deferred === true ? `${b.kind} (deferred)` : b.kind) },
    {
      title: "SOURCE",
      value: (b) =>
        b.source.mcpServer ?? b.source.skill ?? b.source.filePath ?? b.source.tool ?? b.source.attachment ?? "",
      max: 40,
    },
    { title: "TOKENS", value: (b) => count(b.tokens), right: true },
    { title: "BASIS", value: (b) => b.basis ?? "" },
    { title: "CACHED", value: (b) => (b.inCachedPrefix ? "yes" : "") },
    { title: "COST", value: (b) => usd(b.costUsd), right: true },
    { title: "TEXT", value: (b) => b.preview, max: 60 },
  ]);
  const categories = CATEGORIES.filter((k) => ctx.categories[k] > 0)
    .map((k) => `${k} ${count(ctx.categories[k])}`)
    .join(", ");
  const sections = `tools ${count(ctx.sections.tools)}, system ${count(ctx.sections.system)}, messages ${count(ctx.sections.messages)}, framing ${count(ctx.sections.framing)}`;
  const out = [...head, "", body, "", `sections: ${sections}`, `categories: ${categories}`];
  if (diff !== undefined) {
    out.push(
      "",
      diff.previous === undefined
        ? "first call of its lane: every block is new"
        : `against call ${diff.previous}${diff.modelSwitch === true ? " (another model)" : ""}: ${diff.added.length} added, ` +
            `${diff.removed.length} removed, ${diff.moved.length} moved, ` +
            `first change at position ${diff.firstChange ?? "-"}; cache read lost ${count(diff.cacheReadDrop)}; ` +
            `${diff.uncached.length} kept blocks written to the cache again`,
    );
  }
  return `${out.join("\n")}\n`;
}

export function printSql(result: SqlResult): string {
  const columns = result.columns.map(
    (name): Column<SqlResult["rows"][number]> => ({
      title: name,
      value: (row) => {
        const v = row[name];
        return v === null || v === undefined ? "NULL" : typeof v === "object" ? JSON.stringify(v) : String(v);
      },
      right: result.rows.length > 0 && result.rows.every((r) => typeof r[name] === "number" || r[name] === null),
      max: 80,
    }),
  );
  const note = result.truncated
    ? `${result.rows.length} rows shown; more were left out (--limit)`
    : `${result.rows.length} rows`;
  return `${table(result.rows, columns)}\n\n${note}\n`;
}

export function printReport(r: QueryReport): string {
  const lines: string[] = [];
  const list = (title: string, items: string[]) => {
    lines.push(`${title}: ${items.length === 0 ? "none" : ""}`);
    for (const i of items) lines.push(`  ${i}`);
  };
  list(
    "unknown records",
    r.unknownRecords.map((k) => `${k.kind} ${k.count}`),
  );
  list(
    "ignored records",
    r.ignoredRecords.map((k) => `${k.kind} ${k.count}`),
  );
  list(
    "unreadable",
    r.unreadable.map((u) => `${u.log} ${u.at}: ${u.reason}`),
  );
  list(
    "file errors",
    r.errors.map((e) => `${e.path}: ${e.error}`),
  );
  list(
    "scan",
    r.scan.map((s) => `${s.path}: ${s.issue}`),
  );
  list(
    "call issues",
    Object.entries(r.issues).map(([k, n]) => `${k} ${n}`),
  );
  list(
    "request logs",
    r.requestLogs.map((x) => `${x.requestLog} ${x.sessions} sessions`),
  );
  lines.push(`pending: ${bytes(r.pendingBytes)} in ${r.pending.length} files`);
  return `${lines.join("\n")}\n`;
}
