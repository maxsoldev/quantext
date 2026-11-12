/**
 * The context of Call N, exactly as the model received it: the context bar (every Block in request order, coloured
 * by category, with the hidden part and the end of the cached prefix marked), the totals by category, and the
 * ordered block list by section. Opening a Block shows all of its content.
 */
import type { CallContext, ContextBlock, SessionKey } from "@quantext/shared";
import { useEffect, useMemo, useRef, useState } from "react";
import { percent, shortModel, tokens, usd, when } from "../format/format.ts";
import { callNumber } from "../route.ts";
import { Term } from "../teach/Term.tsx";
import { Tokens } from "../ui/Num.tsx";
import type { Load } from "../ui/useLoad.ts";
import { useWindow } from "../ui/useWindow.ts";
import { BlockPanel } from "./BlockPanel.tsx";
import { CATEGORIES, CATEGORY_LABEL } from "./categories.ts";
import { KIND_EXPLAIN, KIND_LABEL, SECTION } from "./kinds.ts";
import type { Row } from "./model.ts";
import { barSegments, hiddenPart, listRows, sourceLabel } from "./model.ts";

const ROW = 48;

/** `ctx` is loaded by the page, which shares it with the diff card. */
export function ContextAt({
  sessionKey,
  call,
  ctx,
  openHash,
  onOpened,
}: {
  sessionKey: SessionKey;
  call: number;
  ctx: Load<CallContext>;
  /** A Block to open once the context is loaded (a link from a tool call). */
  openHash?: string | undefined;
  onOpened?: () => void;
}) {
  const [open, setOpen] = useState<ContextBlock | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const c = ctx.value;
  useEffect(() => {
    if (!openHash || !c || c.call.index !== call) return;
    const b = c.blocks.find((x) => x.hash === openHash);
    if (b) {
      setOpen(b);
      setSelected(b.position);
    }
    onOpened?.();
  }, [openHash, c, call, onOpened]);
  if (ctx.state === "error" && !c) {
    return (
      <p className="error" role="alert">
        The context of call {callNumber(call)} could not be read: {ctx.error.message}
      </p>
    );
  }
  if (!c) return <section className="card context-card muted">Reading the context of call {callNumber(call)}…</section>;
  const stale = c.call.index !== call;
  return (
    <section
      className={stale ? "card context-card stale" : "card context-card"}
      aria-labelledby="context-title"
      data-testid="context"
    >
      <ContextHead ctx={c} />
      {c.rebuilt ? (
        <>
          <ContextBar ctx={c} selected={selected} onPick={(b) => setSelected(b.position)} onOpen={setOpen} />
          <div className="context-body">
            <BlockList ctx={c} selected={selected} onSelect={setSelected} onOpen={setOpen} />
            <CategoryTable ctx={c} />
          </div>
        </>
      ) : (
        <div className="empty">
          <h3>This call's context cannot be shown</h3>
          <p>
            The log holds this call's usage but not its request, so the blocks it sent are unknown. Its token counts and
            cost above are still exact.
          </p>
        </div>
      )}
      {open && <BlockPanel log={sessionKey.log} block={open} call={c.call.index} onClose={() => setOpen(null)} />}
    </section>
  );
}

function ContextHead({ ctx }: { ctx: CallContext }) {
  const u = ctx.call.usage;
  const hidden = hiddenPart(ctx);
  const boundary = ctx.call.cacheBoundary;
  return (
    <div className="context-head">
      <div className="context-title">
        <h2 id="context-title">
          <Term id="context-window">
            Context at call <span className="num">{callNumber(ctx.call.index)}</span>
          </Term>
        </h2>
        <p className="muted">
          {when(ctx.call.ts)}, {shortModel(ctx.call.model)}
          {ctx.call.cost && `, ${usd(ctx.call.cost.totalUsd)}`}
        </p>
      </div>
      {ctx.rebuilt && (
        <p className="context-lede" data-testid="hidden-part">
          The model received <Tokens n={ctx.totalTokens} basis={u?.basis ?? "exact"} note="The call's input total." />{" "}
          tokens. <Tokens n={hidden.tokens} note="Tool schemas plus the system prompt." /> of them (
          {percent(hidden.share)}) are the <Term id="hidden-part">hidden part</Term>: tool schemas and the system
          prompt, sent before the first message and never shown in the chat.
          {u && boundary && (
            <>
              {" "}
              The first <Tokens n={u.cacheReadTokens} note="From the call's usage: cache read tokens." /> were read from
              the <Term id="cached-prefix">cache</Term>.
            </>
          )}
        </p>
      )}
      {ctx.rebuilt && (
        <p className="muted basis-note">
          Before a token number: no mark exact, <b>≈</b> anchored, <b>~</b> estimate, <b>Δ</b> derived.{" "}
          <Term id="token-basis" />
        </p>
      )}
    </div>
  );
}

function ContextBar({
  ctx,
  selected,
  onPick,
  onOpen,
}: {
  ctx: CallContext;
  selected: number | null;
  onPick: (b: ContextBlock) => void;
  onOpen: (b: ContextBlock) => void;
}) {
  const total = Math.max(1, ctx.totalTokens);
  const hidden = hiddenPart(ctx);
  const read = ctx.call.usage?.cacheReadTokens ?? 0;
  const segments = useMemo(() => barSegments(ctx.blocks, ctx.totalTokens), [ctx]);
  return (
    <div className="ctx-bar-wrap">
      <div className="ctx-annot" aria-hidden="true">
        <span className="ctx-hidden" style={{ width: `${(100 * hidden.tokens) / total}%` }}>
          Hidden part
        </span>
      </div>
      <div className="ctx-bar" data-testid="context-bar">
        {segments.map((seg) => {
          const first = seg.blocks[0] as ContextBlock;
          const t = seg.blocks.reduce((n, x) => n + (x.tokens ?? 0), 0);
          const what =
            seg.blocks.length === 1
              ? `${KIND_LABEL[first.kind]} ${sourceLabel(first.source)}`
              : `${seg.blocks.length} small blocks, positions ${first.position} to ${seg.blocks.at(-1)?.position}`;
          return (
            <button
              type="button"
              tabIndex={-1}
              key={first.position}
              className={`ctx-seg cat-${seg.category}${seg.width >= 0.5 ? " gap" : ""}${seg.blocks.some((x) => x.position === selected) ? " selected" : ""}`}
              style={{ left: `${seg.left}%`, width: `${seg.width}%` }}
              data-tip={`${what}\n${tokens(t)} tokens, ${percent(t / total)} of the input\n${CATEGORY_LABEL[seg.category]}${first.inCachedPrefix ? ", read from the cache" : ""}`}
              aria-label={`${what}, ${tokens(t)} tokens`}
              onClick={() => {
                onPick(first);
                onOpen(first);
              }}
            />
          );
        })}
        {read > 0 && (
          <span
            className="ctx-boundary"
            style={{ left: `${(100 * Math.min(read, total)) / total}%` }}
            data-tip={`The cached prefix ends here: the provider read the first ${tokens(read)} tokens from its cache and processed only the rest.`}
          />
        )}
      </div>
      <div className="ctx-scale" aria-hidden="true">
        <span>0</span>
        {read > 0 && (
          <span className="ctx-boundary-label" style={{ left: `${(100 * Math.min(read, total)) / total}%` }}>
            cached up to here
          </span>
        )}
        {read / total < 0.85 && <span>{tokens(ctx.totalTokens)}</span>}
      </div>
    </div>
  );
}

function CategoryTable({ ctx }: { ctx: CallContext }) {
  const total = Math.max(1, ctx.totalTokens);
  const rows = CATEGORIES.map((c) => ({ ...c, tokens: ctx.categories[c.key] })).filter((r) => r.tokens > 0);
  return (
    <table className="cat-table" aria-label="Tokens by category">
      <thead>
        <tr>
          <th scope="col">Category</th>
          <th scope="col" className="right">
            Tokens
          </th>
          <th scope="col" className="right">
            Share
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key}>
            <th scope="row">
              <button type="button" className="tip-anchor legend-item" data-tip={r.explain}>
                <span className={`swatch cat-${r.key}`} aria-hidden="true" />
                {r.label}
              </button>
            </th>
            <td className="right num">{tokens(r.tokens)}</td>
            <td className="right">
              <span className="share">
                <span className="num">{percent(r.tokens / total)}</span>
                <span className="share-track">
                  <span className={`share-fill cat-${r.key}`} style={{ width: `${(100 * r.tokens) / total}%` }} />
                </span>
              </span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function BlockList({
  ctx,
  selected,
  onSelect,
  onOpen,
}: {
  ctx: CallContext;
  selected: number | null;
  onSelect: (position: number) => void;
  onOpen: (b: ContextBlock) => void;
}) {
  const rows = useMemo(() => listRows(ctx), [ctx]);
  const scroller = useRef<HTMLDivElement>(null);
  const w = useWindow(scroller, rows.length, ROW);
  const totalCost = ctx.blocks.reduce((a, b) => a + (b.costUsd ?? 0), 0);
  const total = Math.max(1, ctx.totalTokens);
  const move = (from: number, delta: number) => {
    let i = from + delta;
    while (i >= 0 && i < rows.length && rows[i]?.type !== "block") i += delta;
    const row = rows[i];
    if (row?.type !== "block") return;
    w.reveal(i);
    onSelect(row.block.position);
    requestAnimationFrame(() => scroller.current?.querySelector<HTMLElement>(`[data-i="${i}"]`)?.focus());
  };
  return (
    <div className="block-list" data-testid="block-list">
      <div className="block-list-head" aria-hidden="true">
        <span>#</span>
        <span>Block</span>
        <span className="right">Tokens</span>
        <span>Cache</span>
        <span className="right">Cost</span>
      </div>
      <div className="block-scroll" ref={scroller}>
        <div style={{ height: w.before }} />
        {rows.slice(w.start, w.end).map((row, k) => {
          const i = w.start + k;
          return row.type === "section" ? (
            <SectionRow key={`s-${row.section}`} row={row} total={total} />
          ) : (
            <BlockRow
              key={row.block.position}
              b={row.block}
              i={i}
              total={total}
              totalCost={totalCost}
              selected={selected === row.block.position}
              onOpen={() => onOpen(row.block)}
              onKey={(delta) => move(i, delta)}
              onFocus={() => onSelect(row.block.position)}
            />
          );
        })}
        <div style={{ height: w.after }} />
      </div>
    </div>
  );
}

function SectionRow({ row, total }: { row: Extract<Row, { type: "section" }>; total: number }) {
  const s = SECTION[row.section];
  const hidden = row.section !== "messages";
  return (
    <div className={`section-row section-${row.section}`}>
      <button type="button" className="tip-anchor section-title" data-tip={s.explain}>
        {s.title}
      </button>
      {hidden && <span className="hidden-tag">Hidden from the chat</span>}
      <span className="muted num">
        {row.blocks} {row.blocks === 1 ? "block" : "blocks"}, {tokens(row.tokens)} tokens ({percent(row.tokens / total)}
        )
      </span>
    </div>
  );
}

function BlockRow({
  b,
  i,
  total,
  totalCost,
  selected,
  onOpen,
  onKey,
  onFocus,
}: {
  b: ContextBlock;
  i: number;
  total: number;
  totalCost: number;
  selected: boolean;
  onOpen: () => void;
  onKey: (delta: number) => void;
  onFocus: () => void;
}) {
  const source = sourceLabel(b.source);
  const kindTip = KIND_EXPLAIN[b.kind];
  return (
    <div className={selected ? "block-row selected" : "block-row"} data-testid="block-row">
      <span className="block-pos num muted">{b.position}</span>
      <button
        type="button"
        className="block-main"
        data-i={i}
        onClick={onOpen}
        onFocus={onFocus}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            e.stopPropagation();
            onKey(e.key === "ArrowDown" ? 1 : -1);
          }
        }}
        aria-label={`Open block ${b.position}: ${KIND_LABEL[b.kind]} ${source}`}
      >
        <span className={`kind-dot cat-${b.category}`} aria-hidden="true" />
        <span className="kind" {...(kindTip ? { "data-tip": kindTip } : {})}>
          {KIND_LABEL[b.kind]}
        </span>
        {b.deferred && (
          <span
            className="tag deferred"
            data-tip="A deferred tool: its schema was not in the tool list. A tool search loaded it, so it is sent in the messages, from the call that loaded it on."
          >
            Deferred
          </span>
        )}
        {source && <span className="source">{source}</span>}
        <span className="preview">{b.preview}</span>
      </button>
      <span className="right">
        {b.tokens !== undefined && b.basis ? (
          <Tokens n={b.tokens} basis={b.basis} note={`${percent(b.tokens / total)} of the input.`} />
        ) : (
          <span className="muted">none</span>
        )}
      </span>
      <span>
        <button
          type="button"
          className={b.inCachedPrefix ? "tip-anchor cache-tag cached" : "tip-anchor cache-tag new"}
          data-tip={
            b.inCachedPrefix
              ? "In the cached prefix: read from the provider's cache, at 0.05× to 0.1× of the input price (by model)."
              : "After the cached prefix: written to the cache or sent uncached, at the full price or more."
          }
        >
          {b.inCachedPrefix ? "Cached" : "New"}
        </button>
      </span>
      <span className="right">
        {b.costUsd !== undefined ? (
          <button
            type="button"
            className="tip-anchor num"
            data-tip={`${usd(b.costUsd)}: ${percent(totalCost ? b.costUsd / totalCost : 0)} of this call's input cost. Its tokens at the price of the part they fall in (cache read, cache write or input).`}
          >
            {usd(b.costUsd)}
          </button>
        ) : (
          <span className="muted">none</span>
        )}
      </span>
    </div>
  );
}
