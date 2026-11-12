/**
 * One Session: its numbers, the timeline of one lane, a scrubber over its Calls, and the context of the selected
 * Call. The selected Call is in the URL (`?call=<index>`); with none, the page follows the lane's latest Call.
 */
import type { CallContext, ContextDiff, SessionKey, SessionSummary } from "@quantext/shared";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api/client.ts";
import { laneView, mainLane } from "../chart/lane.ts";
import { TimelineChart } from "../chart/TimelineChart.tsx";
import { Compactions } from "../compaction/Compactions.tsx";
import { ContextAt } from "../context/ContextAt.tsx";
import { CACHE_PARTS, CATEGORIES } from "../context/categories.ts";
import { DiffCard } from "../diff/DiffCard.tsx";
import { duration, percent, projectName, shortModel, usd, when } from "../format/format.ts";
import { useLiveVersion } from "../live/hooks.ts";
import { Link, navigate } from "../nav.tsx";
import type { Route } from "../route.ts";
import { Term } from "../teach/Term.tsx";
import { ToolCalls } from "../tools/ToolCalls.tsx";
import { Tokens } from "../ui/Num.tsx";
import { useLoad } from "../ui/useLoad.ts";

type SessionRoute = Extract<Route, { page: "session" }>;

export function SessionPage({ route }: { route: SessionRoute }) {
  const key = route.key;
  const same = (k: SessionKey) => k.log === key.log && k.id === key.id;
  const version = useLiveVersion((e) => e.kind === "calls" && same(e.session));
  const data = useLoad(
    async (signal) => {
      const [detail, timeline, breaks] = await Promise.all([
        api.session(key, signal),
        api.timeline(key, signal),
        api.cacheBreaks(key, signal),
      ]);
      return { detail, timeline: timeline.items, breaks: breaks.items };
    },
    [key.log, key.id, version],
  );
  const [lane, setLane] = useState<string | undefined>(undefined);
  const chosen = lane ?? (data.value ? mainLane(data.value.detail.lanes) : undefined);
  const view = useMemo(
    () => (data.value && chosen ? laneView(data.value.timeline, data.value.breaks, chosen) : undefined),
    [data.value, chosen],
  );
  const last = view ? view.calls.length - 1 : 0;
  const place = view && route.call !== undefined ? (view.at(route.call) ?? view.nearest(route.call)) : last;
  const callIndex = view?.calls[place]?.index;
  const select = useCallback(
    (p: number) => {
      const c = view?.calls[Math.max(0, Math.min(p, (view?.calls.length ?? 1) - 1))];
      if (c) navigate({ page: "session", key, call: c.index }, { replace: true });
    },
    [view, key],
  );
  usePlaceKeys(place, last, select, !route.view);
  const call = useCallData(key, callIndex, version);
  const goTo = useCallback((n: number) => navigate({ page: "session", key, call: n }, { replace: true }), [key]);
  const clearBlock = useCallback(
    () =>
      navigate({ page: "session", key, ...(route.call === undefined ? {} : { call: route.call }) }, { replace: true }),
    [key, route.call],
  );
  const showDiff = useCallback(() => {
    requestAnimationFrame(() => document.getElementById("what-changed")?.scrollIntoView({ block: "start" }));
  }, []);

  if (data.state === "error" && !data.value) {
    return (
      <div className="empty">
        <h1>This session could not be read</h1>
        <p className="error" role="alert">
          {data.error.message}
        </p>
        <p>
          <Link to={{ page: "sessions" }}>Back to the session list</Link>
        </p>
      </div>
    );
  }
  if (!data.value) return <p className="muted">Reading the session…</p>;
  const { detail } = data.value;
  const s = detail.session;
  const span = s.started && s.ended ? Date.parse(s.ended) - Date.parse(s.started) : undefined;
  return (
    <article className="session-page" aria-labelledby="session-title">
      <header className="session-head">
        <div className="session-name">
          <h1 id="session-title">{s.title ?? `Untitled session ${s.id.slice(0, 8)}`}</h1>
          <p className="muted">
            {s.project && <Link to={{ page: "sessions", project: s.project }}>{projectName(s.project)}</Link>}
            {s.project && (
              <Link to={{ page: "memory", project: s.project }} className="memory-link">
                Project memory
              </Link>
            )}
            {s.started && when(s.started)}
            {span !== undefined && `, ${duration(span)}`}
            {s.harnessVersion && `, Claude Code ${s.harnessVersion}`}
            {s.live && (
              <span className="badge live">
                <span className="live-dot good" aria-hidden="true" />
                Live
              </span>
            )}
          </p>
        </div>
        <dl className="figures">
          <div>
            <dt>Calls</dt>
            <dd className="num">{s.calls.toLocaleString("en-US")}</dd>
          </div>
          <div>
            <dt>Cost</dt>
            <dd>
              <button
                type="button"
                className="tip-anchor num"
                data-tip={`At list prices, from each call's exact usage.\n${CACHE_PARTS.map((p) => `${p.label}: ${usd(partCost(s.cost, p.key))}`).join("\n")}${s.unpricedCalls ? `\n${s.unpricedCalls} calls have no price and are not counted.` : ""}`}
              >
                {usd(s.cost.totalUsd)}
              </button>
            </dd>
          </div>
          <div>
            <dt>Max context</dt>
            <dd>
              <Tokens n={s.maxContextTokens} note="The largest input of one call, from its usage." />
            </dd>
          </div>
          <div>
            <dt>Cache hit</dt>
            <dd>
              <button
                type="button"
                className="tip-anchor num"
                data-tip="Cache read over all input tokens: the share of the input the provider did not process again."
              >
                {s.cacheHitRate === undefined ? "none" : percent(s.cacheHitRate)}
              </button>
            </dd>
          </div>
          <div>
            <dt>Model</dt>
            <dd className="models-inline">{s.models.filter(Boolean).map(shortModel).join(", ")}</dd>
          </div>
        </dl>
      </header>
      {detail.subagents.length > 0 && <Subagents parent={key} items={detail.subagents} />}
      <SessionTabs route={route} compactions={detail.compactions.length} />
      {route.view === "tools" && <ToolCalls route={route} session={s} subagents={detail.subagents} version={version} />}
      {route.view === "compactions" && (
        <Compactions sessionKey={key} timeline={data.value.timeline} version={version} />
      )}
      {!route.view && (
        <>
          {view && view.calls.length > 0 ? (
            <section className="card timeline-card" aria-labelledby="timeline-title">
              <div className="card-head">
                <div className="card-title">
                  <h2 id="timeline-title">Context per call</h2>
                  {detail.lanes.length > 1 && (
                    <fieldset className="lanes">
                      <legend>
                        <Term id="lane">Lane</Term>
                      </legend>
                      {[...detail.lanes]
                        .sort((a, b) => b.calls - a.calls)
                        .map((l) => (
                          <button
                            key={l.lane}
                            type="button"
                            aria-pressed={l.lane === chosen}
                            onClick={() => setLane(l.lane)}
                            data-tip="A lane is the calls that build on each other's context: one model, one purpose. Side queries run in their own lane."
                          >
                            {l.model ? shortModel(l.model) : "Unknown model"} <span className="num">({l.calls})</span>
                          </button>
                        ))}
                    </fieldset>
                  )}
                </div>
                <div className="legends">
                  <Legend />
                  <BillingLegend noUsage={view.calls.some((c) => !c.usage)} />
                </div>
              </div>
              <TimelineChart view={view} selected={place} onSelect={select} onBreak={showDiff} />
            </section>
          ) : (
            <p className="muted">This session has no calls yet.</p>
          )}
          {callIndex !== undefined && view && (
            <DiffCard
              sessionKey={key}
              ctx={call.ctx.value}
              diff={call.diff}
              prev={call.prev.value}
              breaks={view.breaks}
              onGoTo={goTo}
            />
          )}
          {callIndex !== undefined && (
            <ContextAt sessionKey={key} call={callIndex} ctx={call.ctx} openHash={route.block} onOpened={clearBlock} />
          )}
          {view && view.calls.length > 0 && (
            <Scrubber place={place} last={last} index={callIndex ?? 0} onChange={select} />
          )}
        </>
      )}
    </article>
  );
}

const TABS: { view: SessionRoute["view"]; label: string }[] = [
  { view: undefined, label: "Context" },
  { view: "tools", label: "Tool calls" },
  { view: "compactions", label: "Compactions" },
];

/** The views of a Session, as links: each is its own URL. */
function SessionTabs({ route, compactions }: { route: SessionRoute; compactions: number }) {
  return (
    <nav className="tabs" aria-label="Views of this session">
      {TABS.map((t) => (
        <Link
          key={t.label}
          to={{ page: "session", key: route.key, ...(t.view ? { view: t.view } : {}) }}
          aria-current={route.view === t.view ? "page" : undefined}
        >
          {t.label}
          {t.view === "compactions" && <span className="num tab-count"> {compactions}</span>}
        </Link>
      ))}
    </nav>
  );
}

/** The subagent Sessions this Session started: each ran in its own context. */
function Subagents({ parent, items }: { parent: SessionKey; items: readonly SessionSummary[] }) {
  return (
    <p className="subagents" data-testid="subagents">
      <Term id="subagents">{items.length === 1 ? "Subagent" : `${items.length} subagents`}</Term>:{" "}
      {items.map((a, i) => (
        <span key={a.id}>
          {i > 0 && ", "}
          <Link to={{ page: "session", key: { log: parent.log, id: a.id } }}>
            {a.agentName ?? a.title ?? a.id.split(":").at(-1)}
          </Link>{" "}
          <span className="muted num">
            ({a.calls} calls, {usd(a.cost.totalUsd)})
          </span>
        </span>
      ))}
    </p>
  );
}

/** The selected Call's context, its diff, and the context of the Call it is compared with. */
function useCallData(key: SessionKey, call: number | undefined, version: number) {
  const ctx = useLoad(
    (signal) => (call === undefined ? pending<CallContext>() : api.context(key, call, signal)),
    [key.log, key.id, call, version],
  );
  const diff = useLoad(
    (signal) => (call === undefined ? pending<ContextDiff>() : api.diff(key, call, signal)),
    [key.log, key.id, call, version],
  );
  const previous = diff.value?.call === call ? diff.value?.previous : undefined;
  const prev = useLoad(
    async (signal) => (previous === undefined ? undefined : api.context(key, previous, signal)),
    [key.log, key.id, previous],
  );
  return { ctx, diff, prev };
}

/** No Call to load yet: stay loading. */
function pending<T>(): Promise<T> {
  return new Promise<T>(() => undefined);
}

function partCost(c: { cacheReadUsd: number; cacheWriteUsd: number; inputUsd: number; outputUsd: number }, k: string) {
  return k === "cacheRead"
    ? c.cacheReadUsd
    : k === "cacheWrite"
      ? c.cacheWriteUsd
      : k === "input"
        ? c.inputUsd
        : c.outputUsd;
}

function Legend() {
  return (
    <ul className="legend" aria-label="Context categories">
      {CATEGORIES.map((c) => (
        <li key={c.key}>
          <button type="button" className="tip-anchor legend-item" data-tip={c.explain}>
            <span className={`swatch cat-${c.key}`} aria-hidden="true" />
            {c.label}
          </button>
        </li>
      ))}
    </ul>
  );
}

function BillingLegend({ noUsage }: { noUsage: boolean }) {
  return (
    <ul className="legend billing-legend" aria-label="Billing parts">
      {CACHE_PARTS.filter((p) => p.key !== "output").map((p) => (
        <li key={p.key}>
          <button type="button" className="tip-anchor legend-item" data-tip={p.explain}>
            <span className={`swatch cache-${p.key}`} aria-hidden="true" />
            {p.label}
          </button>
        </li>
      ))}
      <li>
        <button
          type="button"
          className="tip-anchor legend-item"
          data-tip="A call that read fewer tokens from the cache than the call before it. Hover a triangle for the reason."
        >
          <span className="swatch break-swatch" aria-hidden="true" />
          Cache break
        </button>
      </li>
      <li>
        <Term id="prompt-cache">Prompt cache</Term>
      </li>
      <li>
        <button
          type="button"
          className="tip-anchor legend-item"
          data-tip="A compaction: the harness replaced the context with a summary. The cache starts again after it."
        >
          <span className="swatch compaction-swatch" aria-hidden="true" />
          Compaction
        </button>
      </li>
      {noUsage && (
        <li>
          <button
            type="button"
            className="tip-anchor legend-item"
            data-tip="A call whose log holds no usage: its tokens and cost are unknown, so it draws as a grey column."
          >
            <span className="swatch no-usage-swatch" aria-hidden="true" />
            No usage
          </button>
        </li>
      )}
    </ul>
  );
}

function Scrubber({
  place,
  last,
  index,
  onChange,
}: {
  place: number;
  last: number;
  index: number;
  onChange: (p: number) => void;
}) {
  return (
    <div className="scrubber">
      <button type="button" onClick={() => onChange(place - 1)} disabled={place <= 0} aria-label="Previous call">
        ←
      </button>
      <input
        type="range"
        min={0}
        max={last}
        value={place}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-label="Call"
        aria-valuetext={`Call ${index}, ${place + 1} of ${last + 1} in this lane`}
        data-testid="scrubber"
      />
      <button type="button" onClick={() => onChange(place + 1)} disabled={place >= last} aria-label="Next call">
        →
      </button>
      <span className="scrubber-pos" data-testid="call-position">
        Call <b className="num">{index}</b>
        <span className="muted num">
          {" "}
          ({place + 1} of {last + 1})
        </span>
      </span>
      <span className="muted keys">
        <kbd>←</kbd> <kbd>→</kbd> step, <kbd>Shift</kbd> 10, <kbd>Home</kbd> <kbd>End</kbd>
      </span>
    </div>
  );
}

/** Arrow keys anywhere on the page (not while typing or on the slider, which has its own) move the selected Call. */
function usePlaceKeys(place: number, last: number, select: (p: number) => void, on: boolean) {
  useEffect(() => {
    if (!on) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.closest("input, select, textarea, [contenteditable]") || e.metaKey || e.ctrlKey || e.altKey)) return;
      const step = e.shiftKey ? 10 : 1;
      const next =
        e.key === "ArrowLeft"
          ? place - step
          : e.key === "ArrowRight"
            ? place + step
            : e.key === "Home"
              ? 0
              : e.key === "End"
                ? last
                : undefined;
      if (next === undefined) return;
      e.preventDefault();
      select(Math.max(0, Math.min(last, next)));
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [place, last, select, on]);
}
