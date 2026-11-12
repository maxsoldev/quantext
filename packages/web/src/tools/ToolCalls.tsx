/**
 * A Session's tool calls: tool, input, output tokens, the Calls its output stayed in, and its lifetime cost (its
 * tokens in each of those Calls, priced). By default the most expensive output comes first. A row opens a panel
 * with the input, an Edit's change, and links to the call, the result block and a subagent's own Session.
 */
import type { SessionSummary } from "@quantext/shared";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api/client.ts";
import { count, duration, percent, shortModel, tokens, usd } from "../format/format.ts";
import { Link, navigate } from "../nav.tsx";
import type { Route, ToolSort } from "../route.ts";
import { callNumber } from "../route.ts";
import { Term } from "../teach/Term.tsx";
import { JsonView } from "../ui/JsonView.tsx";
import { Tokens } from "../ui/Num.tsx";
import { useLoad } from "../ui/useLoad.ts";
import { useWindow } from "../ui/useWindow.ts";
import type { ToolRow } from "./model.ts";
import { editDiff, inputSummary, toolRows } from "./model.ts";

type SessionRoute = Extract<Route, { page: "session" }>;
const ROW = 56;

const SORTS: { key: ToolSort; label: string; tip: string }[] = [
  {
    key: "cost",
    label: "Lifetime cost",
    tip: "What the output cost over the session: its tokens in every call it stayed in, at the price of each part.",
  },
  { key: "tokens", label: "Output tokens", tip: "The output's tokens in the first call that sent it." },
  { key: "calls", label: "Calls kept", tip: "How many calls the output was sent in." },
  { key: "time", label: "Order run", tip: "In the order the model called the tools." },
];

export function ToolCalls({
  route,
  session,
  subagents,
  version,
}: {
  route: SessionRoute;
  session: SessionSummary;
  subagents: readonly SessionSummary[];
  version: number;
}) {
  const key = route.key;
  const sort = route.sort ?? "cost";
  const data = useLoad(
    async (signal) => {
      const [calls, outputs] = await Promise.all([api.toolCalls(key, signal), api.toolOutputs(key, signal)]);
      return { calls: calls.items, outputs: outputs.items };
    },
    [key.log, key.id, version],
  );
  const rows = useMemo(
    () => (data.value ? toolRows(data.value.calls, data.value.outputs, sort) : []),
    [data.value, sort],
  );
  const [open, setOpen] = useState<ToolRow | null>(null);
  if (data.state === "error" && !data.value) {
    return (
      <p className="error" role="alert">
        The tool calls could not be read: {data.error.message}
      </p>
    );
  }
  if (!data.value) return <section className="card muted">Reading the tool calls…</section>;
  const outputCost = rows.reduce((n, r) => n + (r.lifetime?.costUsd.total ?? 0), 0);
  const inputCost = session.cost.totalUsd - session.cost.outputUsd;
  const maxCost = Math.max(1e-12, ...rows.map((r) => r.lifetime?.costUsd.total ?? 0));
  return (
    <section className="card tools-card" aria-labelledby="tools-title" data-testid="tool-calls">
      <div className="tools-head">
        <h2 id="tools-title">Tool calls</h2>
        {rows.length > 0 && (
          <p className="tools-lede">
            {count(rows.length, "tool call")}. Their outputs cost{" "}
            <button
              type="button"
              className="tip-anchor num"
              data-tip={`${usd(outputCost)}: the lifetime cost of every tool output, of ${usd(inputCost)} input cost in the session.`}
            >
              {usd(outputCost)}
            </button>
            {inputCost > 0 && <>, {percent(outputCost / inputCost)} of the session's input cost</>}. A tool's output
            stays in the context of every later call until a compaction removes it, so each call pays for it again,
            mostly at the cache read price: its <Term id="lifetime-cost">lifetime cost</Term>.
          </p>
        )}
      </div>
      {rows.length === 0 ? (
        <div className="empty">
          <h3>No tool calls in this session</h3>
          <p>The model answered without using a tool.</p>
        </div>
      ) : (
        <>
          <fieldset className="lanes sort-by">
            <legend>Sort by</legend>
            {SORTS.map((s) => (
              <button
                key={s.key}
                type="button"
                aria-pressed={s.key === sort}
                data-tip={s.tip}
                onClick={() => navigate({ ...route, sort: s.key }, { replace: true })}
              >
                {s.label}
              </button>
            ))}
          </fieldset>
          <ToolTable rows={rows} maxCost={maxCost} onOpen={setOpen} selected={open?.call.id} cwd={session.cwd} />
        </>
      )}
      {open && (
        <ToolPanel
          cwd={session.cwd}
          row={open}
          route={route}
          child={subagents.find((s) => s.id === open.call.childSessionId)}
          onClose={() => setOpen(null)}
        />
      )}
    </section>
  );
}

function ToolTable({
  rows,
  maxCost,
  onOpen,
  selected,
  cwd,
}: {
  cwd: string | undefined;
  rows: ToolRow[];
  maxCost: number;
  onOpen: (r: ToolRow) => void;
  selected: string | undefined;
}) {
  const scroller = useRef<HTMLTableSectionElement>(null);
  const w = useWindow(scroller, rows.length, ROW);
  const onKey = (e: ReactKeyboardEvent<HTMLTableSectionElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const row = (e.target as HTMLElement).closest<HTMLElement>("[data-row]");
    if (!row) return;
    e.preventDefault();
    const next = Number(row.dataset.row) + (e.key === "ArrowDown" ? 1 : -1);
    if (next < 0 || next >= rows.length) return;
    w.reveal(next);
    requestAnimationFrame(() => scroller.current?.querySelector<HTMLElement>(`[data-row="${next}"] button`)?.focus());
  };
  return (
    <table className="table tools-table" aria-label="Tool calls" aria-rowcount={rows.length + 1}>
      <thead className="thead">
        <tr className="tr">
          <th scope="col" className="right">
            Call
          </th>
          <th scope="col">Tool and input</th>
          <th scope="col" className="right">
            Output
          </th>
          <th scope="col" className="right">
            Kept in
          </th>
          <th scope="col">Lifetime cost</th>
        </tr>
      </thead>
      <tbody className="tbody" ref={scroller} onKeyDown={onKey} data-testid="tool-rows">
        <tr className="spacer" style={{ height: w.before }} />
        {rows.slice(w.start, w.end).map((r, i) => (
          <ToolRowView
            cwd={cwd}
            key={r.call.id}
            r={r}
            index={w.start + i}
            maxCost={maxCost}
            selected={selected === r.call.id}
            onOpen={() => onOpen(r)}
          />
        ))}
        <tr className="spacer" style={{ height: w.after }} />
      </tbody>
    </table>
  );
}

function ToolRowView({
  cwd,
  r,
  index,
  maxCost,
  selected,
  onOpen,
}: {
  cwd: string | undefined;
  r: ToolRow;
  index: number;
  maxCost: number;
  selected: boolean;
  onOpen: () => void;
}) {
  const c = r.call;
  const l = r.lifetime;
  const cost = l?.costUsd.total ?? 0;
  return (
    <tr className={selected ? "tr selected" : "tr"} data-row={index} data-testid="tool-row" aria-rowindex={index + 2}>
      <td className="right num muted">{c.callIndex ?? "none"}</td>
      <td>
        <button
          type="button"
          className="tool-main"
          onClick={onOpen}
          aria-label={`Open the tool call: ${c.name}, ${inputSummary(c.name, c.input, cwd)}`}
        >
          <span className="tool-name">{c.name}</span>
          {c.isError && <span className="tag error-tag">Error</span>}
          {c.childSessionId && <span className="tag">Subagent</span>}
          <span className="tool-input content">{inputSummary(c.name, c.input, cwd)}</span>
        </button>
      </td>
      <td className="right">
        {c.resultTokens !== undefined ? (
          <Tokens
            n={c.resultTokens}
            basis={c.resultBasis ?? "exact"}
            note="The output's tokens in the first call that sent it."
          />
        ) : (
          <span className="muted">none</span>
        )}
      </td>
      <td className="right">
        {l ? (
          <button
            type="button"
            className="tip-anchor num"
            data-tip={`Sent in ${count(l.calls, "call")}${l.firstCall !== undefined ? `, from call ${l.firstCall} to ${l.lastCall}` : ""}.`}
          >
            {count(l.calls, "call")}
          </button>
        ) : (
          <span className="muted">none</span>
        )}
      </td>
      <td>
        {l ? (
          <span className="share">
            <button type="button" className="tip-anchor num" data-tip={lifetimeTip(l)}>
              {usd(cost)}
            </button>
            <span className="share-track">
              <span className="share-fill cat-tool-outputs" style={{ width: `${(100 * cost) / maxCost}%` }} />
            </span>
          </span>
        ) : (
          <span className="muted">none</span>
        )}
      </td>
    </tr>
  );
}

function lifetimeTip(l: NonNullable<ToolRow["lifetime"]>): string {
  return [
    `${usd(l.costUsd.total)} over ${count(l.calls, "call")}: ${tokens(l.lifetimeTokens)} tokens in all, its tokens in each call it was sent in.`,
    `Cache read: ${tokens(l.tokensByPart.cacheRead)} tokens, ${usd(l.costUsd.cacheRead)}`,
    `Cache write: ${tokens(l.tokensByPart.cacheWrite)} tokens, ${usd(l.costUsd.cacheWrite)}`,
    `Uncached input: ${tokens(l.tokensByPart.input)} tokens, ${usd(l.costUsd.input)}`,
  ].join("\n");
}

function ToolPanel({
  cwd,
  row,
  route,
  child,
  onClose,
}: {
  cwd: string | undefined;
  row: ToolRow;
  route: SessionRoute;
  child: SessionSummary | undefined;
  onClose: () => void;
}) {
  const c = row.call;
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    close.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    addEventListener("keydown", onKey);
    return () => {
      removeEventListener("keydown", onKey);
      before?.focus?.();
    };
  }, [onClose]);
  const diff = editDiff(c.name, c.input);
  const first = row.lifetime?.firstCall ?? c.callIndex;
  return (
    <aside className="block-panel" aria-labelledby="tool-title" data-testid="tool-panel">
      <div className="block-panel-head">
        <div>
          <h3 id="tool-title">{c.name}</h3>
          <p className="content tool-what">{inputSummary(c.name, c.input, cwd)}</p>
          <p className="muted">
            Called in call {c.callIndex === undefined ? "unknown" : callNumber(c.callIndex)}
            {c.durationMs !== undefined && `, ran ${duration(c.durationMs)}`}
            {c.parallel > 1 && `, one of ${c.parallel} tool calls in parallel`}
            {c.isError && ", returned an error"}
          </p>
        </div>
        <button type="button" ref={close} onClick={onClose} aria-label="Close the tool call">
          Close
        </button>
      </div>
      <ul className="panel-links">
        {c.callIndex !== undefined && (
          <li>
            <Link to={{ page: "session", key: route.key, call: c.callIndex }}>
              Open call {callNumber(c.callIndex)}, which called it
            </Link>
          </li>
        )}
        {c.resultBlockHash && first !== undefined && (
          <li>
            <Link to={{ page: "session", key: route.key, call: first, block: c.resultBlockHash }}>
              Open its output in the context of call {callNumber(first)}
            </Link>
          </li>
        )}
        {c.childSessionId && (
          <li>
            <Link
              to={{ page: "session", key: { log: route.key.log, id: c.childSessionId } }}
              data-testid="subagent-link"
            >
              Open the subagent's session
            </Link>
            {child && (
              <span className="muted">
                {" "}
                ({child.calls} calls, {usd(child.cost.totalUsd)}, max context {tokens(child.maxContextTokens)},{" "}
                {child.models.filter(Boolean).map(shortModel).join(", ")})
              </span>
            )}
          </li>
        )}
      </ul>
      {c.childSessionId && (
        <p className="explain">
          A subagent runs in its own context: its own system prompt and tools, and only the task it was given. Only its
          final answer comes back here, as this tool call's output.
        </p>
      )}
      {diff && (
        <figure className="edit-diff" data-testid="edit-diff">
          <figcaption>The change it asked for</figcaption>
          <pre className="content">
            {diff.map((l, i) =>
              l.kind === "gap" ? (
                // biome-ignore lint/suspicious/noArrayIndexKey: lines have no identity but their place.
                <span key={i} className="diff-gap" aria-hidden="true">
                  {"\n"}
                </span>
              ) : (
                // biome-ignore lint/suspicious/noArrayIndexKey: lines have no identity but their place.
                <span key={i} className={`diff-line diff-${l.kind}`}>
                  <span className="diff-sign" aria-hidden="true">
                    {l.kind === "add" ? "+" : l.kind === "del" ? "−" : " "}
                  </span>
                  {l.kind !== "same" && (
                    <span className="visually-hidden">{l.kind === "add" ? "Added: " : "Removed: "}</span>
                  )}
                  {l.text}
                  {"\n"}
                </span>
              ),
            )}
          </pre>
        </figure>
      )}
      <details className="block-raw" open={!diff}>
        <summary>Input</summary>
        <div className="content json">
          <JsonView value={c.input} />
        </div>
      </details>
    </aside>
  );
}
