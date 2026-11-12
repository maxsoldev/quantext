/**
 * All Sessions, newest first by default: a windowed table with filters in the URL. Each row says what the Session
 * cost and how, its largest context, its cache hit rate, whether its requests can be rebuilt, and its issues.
 */
import type { Page, SessionSummary } from "@quantext/shared";
import type { KeyboardEvent } from "react";
import { useEffect, useRef, useState } from "react";
import { api } from "../api/client.ts";
import { CACHE_PARTS } from "../context/categories.ts";
import { ago, percent, projectName, shortModel, usd, when } from "../format/format.ts";
import { useLiveVersion } from "../live/hooks.ts";
import { Link, navigate } from "../nav.tsx";
import type { Route, SortKey } from "../route.ts";
import { ISSUE_WORDS } from "../teach/glossary.ts";
import { Tokens } from "../ui/Num.tsx";
import { SplitBar } from "../ui/SplitBar.tsx";
import { useLoad } from "../ui/useLoad.ts";
import { useWindow } from "../ui/useWindow.ts";
import { mergeSessions } from "./merge.ts";
import { costSplit } from "./totals.ts";

type ListRoute = Extract<Route, { page: "sessions" }>;

const ROW = 68;
const PAGE = 500;

const SORTS: { key: SortKey; label: string }[] = [
  { key: "ended", label: "Last active" },
  { key: "started", label: "Started" },
  { key: "cost", label: "Cost" },
  { key: "calls", label: "Calls" },
];

const REQUEST_LOG: Record<SessionSummary["requestLog"], { word: string; explain: string }> = {
  present: { word: "Full", explain: "The log holds every request: each call's context can be rebuilt block by block." },
  partial: {
    word: "Partial",
    explain: "The log holds some requests. Calls without one have exact usage and cost, but no blocks.",
  },
  absent: {
    word: "Usage only",
    explain:
      "The log holds no requests, only usage: it is from a harness version that did not log them. Tokens and cost are exact; the context cannot be shown.",
  },
};

export function SessionList({ route }: { route: ListRoute }) {
  const [search, setSearch] = useState(route.search ?? "");
  const [limit, setLimit] = useState(PAGE);
  // A removed log or a resync reads the list again; new and changed Sessions are merged in.
  const full = useLiveVersion((e) => e.kind === "log-removed");
  const changes = useLiveVersion((e) => e.kind === "calls");
  const filter = {
    ...(route.project ? { project: route.project } : {}),
    ...(route.search ? { search: route.search } : {}),
    sort: route.sort ?? "ended",
    order: "desc" as const,
  };
  const page = useSessionList(filter, limit, full, changes);
  const projects = useLoad((signal) => api.projects(signal), [full, changes]);

  // Typing filters after a short pause, and keeps the URL in step (replace: no history entry per key).
  useEffect(() => {
    const t = setTimeout(() => {
      const next = search.trim();
      if (next !== (route.search ?? "")) navigate(clean({ ...route, search: next }), { replace: true });
    }, 250);
    return () => clearTimeout(t);
  }, [search, route]);

  const set = (patch: Patch) => navigate(clean({ ...route, ...patch }));
  const items = page.value?.items ?? [];
  const total = page.value?.total ?? 0;
  return (
    <section className="sessions-page" aria-labelledby="sessions-title">
      <div className="page-head">
        <h1 id="sessions-title">Sessions</h1>
        <p className="lede">
          {page.value ? (
            <>
              <span className="num">{total.toLocaleString("en-US")}</span> {total === 1 ? "session" : "sessions"}
              {route.project ? ` in ${projectName(route.project)}` : ""}. Open one to see what the model received on
              each call.
            </>
          ) : (
            "Reading sessions…"
          )}
        </p>
      </div>
      <search className="filters">
        <label className="field">
          <span>Find</span>
          <input
            type="search"
            value={search}
            placeholder="Title or session id"
            onChange={(e) => setSearch(e.target.value)}
            data-testid="search"
          />
        </label>
        <label className="field">
          <span>Project</span>
          <select
            value={route.project ?? ""}
            onChange={(e) => set({ project: e.target.value || undefined })}
            data-testid="project-filter"
          >
            <option value="">All projects</option>
            {projects.value?.items.map((p) => (
              <option key={p.project} value={p.project}>
                {projectName(p.project)} ({p.sessions})
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Sort by</span>
          <select
            value={route.sort ?? "ended"}
            onChange={(e) => set({ sort: e.target.value as SortKey })}
            data-testid="sort"
          >
            {SORTS.map((s) => (
              <option key={s.key} value={s.key}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
      </search>
      {page.state === "error" && (
        <p className="error" role="alert">
          The engine did not give the sessions: {page.error.message}
        </p>
      )}
      {page.value && items.length === 0 && (
        <div className="empty">
          <h2>No sessions {route.search || route.project ? "match" : "yet"}</h2>
          <p>
            {route.search || route.project
              ? "Change the filters above, or clear them."
              : "The engine has read no session logs yet. Start a Claude Code session: it appears here as it runs."}
          </p>
        </div>
      )}
      {items.length > 0 && (
        <SessionTable
          items={items}
          total={total}
          onMore={() => setLimit((l) => (l <= items.length ? l + PAGE : l))}
          sort={route.sort ?? "ended"}
        />
      )}
    </section>
  );
}

type Patch = { [K in keyof ListRoute]?: ListRoute[K] | undefined };

/** The Route without empty or default fields, so equal filters give one URL. */
function clean(route: Patch): ListRoute {
  const out: ListRoute = { page: "sessions" };
  if (route.project) out.project = route.project;
  if (route.sort && route.sort !== "ended") out.sort = route.sort;
  if (route.search) out.search = route.search;
  return out;
}

type Filter = Parameters<typeof api.sessions>[0] & { sort: SortKey };

/**
 * The first `limit` Sessions, read in full when the filter, the limit or `full` changes, and kept up to date on
 * `changes` by reading only the Sessions changed since the last cursor (pages of 500; more than that reads all).
 */
function useSessionList(filter: Filter, limit: number, full: number, changes: number) {
  const fkey = JSON.stringify(filter);
  const [list, setList] = useState<{ key: string; full: number; page: Page<SessionSummary> } | undefined>(undefined);
  const page = useLoad(
    async (signal) => {
      const prev = list?.key === `${fkey}|${limit}` && list.full === full ? list.page : undefined;
      if (prev?.cursor !== undefined) {
        const [changed, head] = await Promise.all([
          api.sessions({ ...filter, changedSince: prev.cursor, limit: PAGE }, signal),
          api.sessions({ ...filter, limit: 1 }, signal),
        ]);
        if (changed.total <= changed.items.length) {
          const items = mergeSessions(prev.items, changed.items, filter.sort);
          const cursor = changed.cursor ?? prev.cursor;
          return { ...prev, total: head.total, items, cursor };
        }
      }
      return loadAll(filter, limit, signal);
    },
    // biome-ignore lint/correctness/useExhaustiveDependencies: `list` is the previous result, not an input.
    [fkey, limit, full, changes],
  );
  useEffect(() => {
    if (page.state === "ready") setList({ key: `${fkey}|${limit}`, full, page: page.value });
  }, [page, fkey, limit, full]);
  return page;
}

/** The first `limit` Sessions, in pages of at most 500 (the API's cap). */
async function loadAll(filter: Filter, limit: number, signal: AbortSignal): Promise<Page<SessionSummary>> {
  let page = await api.sessions({ ...filter, limit: Math.min(limit, PAGE), offset: 0 }, signal);
  const items = [...page.items];
  while (items.length < Math.min(limit, page.total)) {
    page = await api.sessions({ ...filter, limit: PAGE, offset: items.length }, signal);
    if (page.items.length === 0) break;
    items.push(...page.items);
  }
  return { ...page, offset: 0, items };
}

function SessionTable({
  items,
  total,
  onMore,
  sort,
}: {
  items: SessionSummary[];
  total: number;
  onMore: () => void;
  sort: SortKey;
}) {
  const scroller = useRef<HTMLTableSectionElement>(null);
  const w = useWindow(scroller, items.length, ROW);
  const now = Date.now();
  useEffect(() => {
    if (w.end >= items.length - 10 && items.length < total) onMore();
  }, [w.end, items.length, total, onMore]);
  // Up and down move between rows; the row's link has the focus, so Enter opens it.
  const onKey = (e: KeyboardEvent<HTMLTableSectionElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const row = (e.target as HTMLElement).closest<HTMLElement>("[data-row]");
    if (!row) return;
    e.preventDefault();
    const next = Number(row.dataset.row) + (e.key === "ArrowDown" ? 1 : -1);
    if (next < 0 || next >= items.length) return;
    w.reveal(next);
    requestAnimationFrame(() =>
      scroller.current?.querySelector<HTMLElement>(`[data-row="${next}"] .session-title`)?.focus(),
    );
  };
  return (
    <table className="table sessions-table" aria-label="Sessions" aria-rowcount={total + 1}>
      <thead className="thead">
        <tr className="tr">
          <th scope="col">Session</th>
          <th scope="col" aria-sort={sort === "ended" || sort === "started" ? "descending" : undefined}>
            {sort === "started" ? "Started" : "Last active"}
          </th>
          <th scope="col">Model</th>
          <th scope="col" className="right" aria-sort={sort === "calls" ? "descending" : undefined}>
            Calls
          </th>
          <th scope="col" className="right" aria-sort={sort === "cost" ? "descending" : undefined}>
            Cost
          </th>
          <th scope="col" className="right">
            Max context
          </th>
          <th scope="col" className="right">
            Cache hit
          </th>
          <th scope="col">Requests</th>
          <th scope="col" className="right">
            Issues
          </th>
        </tr>
      </thead>
      <tbody className="tbody" ref={scroller} onKeyDown={onKey} data-testid="sessions">
        <tr className="spacer" style={{ height: w.before }} />
        {items.slice(w.start, w.end).map((s, i) => (
          <Row key={`${s.log}/${s.id}`} s={s} index={w.start + i} sort={sort} now={now} />
        ))}
        <tr className="spacer" style={{ height: w.after }} />
      </tbody>
    </table>
  );
}

function Row({ s, index, sort, now }: { s: SessionSummary; index: number; sort: SortKey; now: number }) {
  const time = sort === "started" ? s.started : (s.ended ?? s.started);
  const issues = Object.entries(s.issues).filter(([, n]) => (n ?? 0) > 0);
  const issueCount = issues.reduce((a, [, n]) => a + (n ?? 0), 0);
  const rl = REQUEST_LOG[s.requestLog];
  const all = s.totals.all;
  const costParts = {
    cacheRead: all.cost.cacheReadUsd,
    cacheWrite: all.cost.cacheWriteUsd,
    input: all.cost.inputUsd,
    output: all.cost.outputUsd,
  };
  const split = costSplit(s, s.subagents ?? [], 3);
  const unpriced =
    all.unpricedCalls > 0 ? `\n${all.unpricedCalls} calls have no list price: their cost is not counted.` : "";
  const costTip =
    split.lines.length > 0
      ? `${usd(split.total)} with its subagents, at list prices.\n${split.lines.join("\n")}${unpriced}`
      : `${usd(split.total)} at list prices: the session has no subagents.${unpriced}`;
  return (
    <tr className="tr" data-row={index} data-testid="session-row" aria-rowindex={index + 2}>
      <td className="cell-session">
        <Link to={{ page: "session", key: s }} className="session-title">
          {s.title ?? <span className="muted">Untitled {s.id.slice(0, 8)}</span>}
        </Link>
        <span className="sub">
          {s.project && <span className="project">{projectName(s.project)}</span>}
          {s.live && (
            <span className="badge live" data-testid="live-badge">
              <span className="live-dot good" aria-hidden="true" />
              Live
            </span>
          )}
          {s.subagents && s.subagents.length > 0 && (
            <span className="muted">
              {s.subagents.length} {s.subagents.length === 1 ? "subagent" : "subagents"}
            </span>
          )}
        </span>
      </td>
      <td>
        {time && (
          <>
            <span>{ago(time, now)}</span>
            <span className="sub num">{when(time)}</span>
          </>
        )}
      </td>
      <td className="models">
        {s.models
          .filter((m) => m !== "")
          .map((m) => (
            <span key={m} className="model">
              {shortModel(m)}
            </span>
          ))}
      </td>
      <td className="right num" data-testid="calls">
        {s.calls.toLocaleString("en-US")}
      </td>
      <td className="right cell-cost">
        <button type="button" className="tip-anchor num" data-testid="session-cost" data-tip={costTip}>
          {usd(split.total)}
        </button>
        <SplitBar
          title={`Cost by part${split.lines.length > 0 ? ", with the subagents" : ""}, at list prices.${unpriced}`}
          slices={CACHE_PARTS.map((p) => ({
            key: p.key,
            label: p.label,
            value: costParts[p.key],
            text: usd(costParts[p.key]),
            className: `cache-${p.key}`,
          }))}
        />
      </td>
      <td className="right">
        <Tokens
          n={s.maxContextTokens}
          note="The largest input of one call in this session, from its exact usage. Summarising calls (derived usage) are left out."
        />
      </td>
      <td className="right cell-meter">
        {s.cacheHitRate === undefined ? (
          <span className="muted">none</span>
        ) : (
          <>
            <span className="num">{percent(s.cacheHitRate)}</span>
            <span
              className="meter"
              data-tip="Cache read over all input tokens of the session: the share the provider did not process again."
            >
              <span className="meter-fill" style={{ width: `${100 * s.cacheHitRate}%` }} />
            </span>
          </>
        )}
      </td>
      <td>
        <button type="button" className={`tip-anchor request-log rl-${s.requestLog}`} data-tip={rl.explain}>
          {rl.word}
        </button>
      </td>
      <td className="right">
        {issueCount === 0 ? (
          <span className="muted">none</span>
        ) : (
          <button
            type="button"
            className="tip-anchor issues num"
            data-tip={`Calls with issues, by kind:\n${issues.map(([k, n]) => `${ISSUE_WORDS[k as keyof typeof ISSUE_WORDS] ?? k}: ${n}`).join("\n")}`}
          >
            <span aria-hidden="true">!</span> {issueCount}
          </button>
        )}
      </td>
    </tr>
  );
}
