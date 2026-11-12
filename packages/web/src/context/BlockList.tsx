/**
 * The block list of Call N: a section per part of the request, each folding to one summary row, the blocks with
 * their parts under a chevron, then the Output section (what the model answered, priced as output). Windowed;
 * arrow keys step through the rows, `e` and `c` open and close all.
 */
import type {
  CallContext,
  CallResponseDetail,
  ContextBlock,
  ContextPart,
  ResponseEntry,
  SessionKey,
} from "@quantext/shared";
import type { KeyboardEvent, ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { percent, tokens, usd } from "../format/format.ts";
import { Link } from "../nav.tsx";
import { stopWords, toolWords } from "../response/model.ts";
import { callNumber } from "../route.ts";
import { partTeach } from "../teach/parts.ts";
import { Term } from "../teach/Term.tsx";
import { Tokens } from "../ui/Num.tsx";
import { useWindow } from "../ui/useWindow.ts";
import type { Collapse, Fold } from "./collapse.ts";
import { KIND_EXPLAIN, KIND_LABEL, SECTION } from "./kinds.ts";
import type { Row, SectionHead } from "./model.ts";
import { blockSource, listRows, outputRows } from "./model.ts";

const ROW = 48;

export interface ListActions {
  onSelect: (position: number) => void;
  onOpen: (b: ContextBlock, part?: number) => void;
  onOpenOutput: (e: ResponseEntry, n: number) => void;
  onFold: (fold: Fold) => void;
  onParts: (b: ContextBlock) => void;
  onAll: (open: boolean) => void;
}

export function BlockList({
  sessionKey,
  ctx,
  resp,
  next,
  cwd,
  fold,
  selected,
  jump,
  act,
}: {
  sessionKey: SessionKey;
  ctx: CallContext;
  /** The Call's answer; absent while it loads or for another call. */
  resp: CallResponseDetail | undefined;
  next: number | undefined;
  cwd: string | undefined;
  fold: Collapse;
  selected: number | null;
  /** A block to scroll to (a link to it); `n` changes on each jump. */
  jump: { position: number; n: number } | undefined;
  act: ListActions;
}) {
  const [find, setFind] = useState("");
  const rows = useMemo(
    () => [...listRows(ctx, find, fold), ...outputRows(resp, { find, open: fold.open.output, next })],
    [ctx, resp, find, fold, next],
  );
  const scroller = useRef<HTMLDivElement>(null);
  const w = useWindow(scroller, rows.length, ROW);
  const totalCost = ctx.blocks.reduce((a, b) => a + (b.costUsd ?? 0), 0);
  const total = Math.max(1, ctx.totalTokens);
  const matched = rows.filter((r) => r.type === "block").length;
  const { reveal } = w;
  useEffect(() => {
    if (jump === undefined) return;
    const i = rows.findIndex((r) => r.type === "block" && r.block.position === jump.position);
    if (i >= 0) reveal(i);
  }, [jump, rows, reveal]);
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.metaKey || e.ctrlKey || e.altKey || t?.closest("input, select, textarea, [contenteditable], dialog"))
        return;
      if (e.key === "e" || e.key === "c") {
        e.preventDefault();
        act.onAll(e.key === "e");
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [act]);
  const move = (from: number, delta: number) => {
    let i = from + delta;
    while (i >= 0 && i < rows.length && rows[i]?.type === "note") i += delta;
    const row = rows[i];
    if (row === undefined || row.type === "note") return;
    w.reveal(i);
    if (row.type === "block" || row.type === "part") act.onSelect(row.block.position);
    requestAnimationFrame(() => scroller.current?.querySelector<HTMLElement>(`[data-i="${i}"]`)?.focus());
  };
  const draw = (row: Row, i: number): ReactNode => {
    const onKey = (delta: number) => move(i, delta);
    const id = regionId(rows, i);
    switch (row.type) {
      case "section":
        return <SectionRow key={`s-${row.section}`} row={row} i={i} total={total} act={act} onKey={onKey} />;
      case "part":
        return (
          <PartRow
            key={`${row.block.position}-${row.part.start}`}
            b={row.block}
            part={row.part}
            i={i}
            id={id}
            total={total}
            onOpen={() => act.onOpen(row.block, row.part.start)}
            onKey={onKey}
            onFocus={() => act.onSelect(row.block.position)}
          />
        );
      case "output":
        return (
          <OutputRow
            key={`o-${row.entry.hash}-${row.n}`}
            e={row.entry}
            n={row.n}
            i={i}
            id={id}
            sessionKey={sessionKey}
            cwd={cwd}
            onOpen={() => act.onOpenOutput(row.entry, row.n)}
            onKey={onKey}
          />
        );
      case "note":
        return <NoteRow key="note" row={row} id={id} sessionKey={sessionKey} />;
      default:
        return (
          <BlockRow
            key={row.block.position}
            row={row}
            i={i}
            id={id}
            total={total}
            totalCost={totalCost}
            sessionKey={sessionKey}
            selected={selected === row.block.position}
            onOpen={() => act.onOpen(row.block)}
            onParts={() => act.onParts(row.block)}
            onKey={onKey}
            onFocus={() => act.onSelect(row.block.position)}
          />
        );
    }
  };
  return (
    <div className="block-list" data-testid="block-list">
      <div className="block-find">
        <input
          type="search"
          value={find}
          onChange={(e) => setFind(e.target.value)}
          onKeyDown={(e) => e.stopPropagation()}
          placeholder="Find a block by kind, source or text"
          aria-label="Find a block"
          data-testid="block-find"
        />
        {find.trim() !== "" && (
          <span className="muted" role="status">
            {matched === 0
              ? `No block matches “${find.trim()}”.`
              : `${matched} of ${ctx.blocks.length} ${ctx.blocks.length === 1 ? "block" : "blocks"}`}
          </span>
        )}
        <div className="fold-all">
          <button type="button" onClick={() => act.onAll(true)} aria-keyshortcuts="e" data-testid="expand-all">
            Expand all
          </button>
          <button type="button" onClick={() => act.onAll(false)} aria-keyshortcuts="c" data-testid="collapse-all">
            Collapse all
          </button>
        </div>
      </div>
      <div className="block-list-head" aria-hidden="true">
        <span>#</span>
        <span>Block</span>
        <span className="right">Tokens</span>
        <span>Cache</span>
        <span className="right">Cost</span>
      </div>
      <div className="block-scroll" ref={scroller}>
        <div style={{ height: w.before }} />
        {rows.slice(w.start, w.end).map((row, k) => draw(row, w.start + k))}
        <div style={{ height: w.after }} />
      </div>
    </div>
  );
}

/**
 * The id a toggle's `aria-controls` names: the first row of a section (`fold-<section>`) or of a block's parts
 * (`parts-<position>`); undefined for other rows.
 */
function regionId(rows: readonly Row[], i: number): string | undefined {
  const before = rows[i - 1];
  const row = rows[i];
  if (before?.type === "section" && row?.type !== "section") return `fold-${before.section}`;
  if (row?.type === "part" && before?.type === "block") return `parts-${row.block.position}`;
  return undefined;
}

/** Arrow keys step through the rows. */
function arrows(onKey: (delta: number) => void) {
  return (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      e.stopPropagation();
      onKey(e.key === "ArrowDown" ? 1 : -1);
    }
  };
}

const OUTPUT = {
  title: "Output — what the model answered",
  explain:
    "The blocks the model wrote on this call, priced at the output price. Not part of the input above: the next call sends them back as input.",
};

/** Folds a section: its title, then what it holds (count, tokens, cache split, cost) in the list's columns. */
function SectionRow({
  row,
  i,
  total,
  act,
  onKey,
}: {
  row: SectionHead;
  i: number;
  total: number;
  act: ListActions;
  onKey: (delta: number) => void;
}) {
  const s = row.section === "output" ? OUTPUT : SECTION[row.section];
  const output = row.section === "output";
  const share = output ? "" : `, ${percent(row.tokens / total)} of the input`;
  const cache =
    row.fresh === 0 ? "All cached" : row.cached === 0 ? "All new" : `${percent(row.cached / row.tokens)} cached`;
  return (
    <div
      className={`block-row section-row section-${row.section}${row.open ? " open" : ""}`}
      data-testid="section-row"
      data-section={row.section}
    >
      <button
        type="button"
        className="section-toggle"
        data-i={i}
        aria-expanded={row.open}
        aria-controls={`fold-${row.section}`}
        onClick={() => act.onFold(row.section)}
        onKeyDown={arrows(onKey)}
        data-tip={s.explain}
      >
        <span className="chevron" aria-hidden="true" />
        <span className="section-title">
          {output ? (
            <>
              Output<span className="wide-only"> — what the model answered</span>
            </>
          ) : (
            s.title
          )}
        </span>
        {(row.section === "tools" || row.section === "system") && (
          <span className="hidden-tag">Hidden from the chat</span>
        )}
        {output && <span className="tag output-price">Output price</span>}
        <span className="muted num section-count">
          {row.blocks} {row.blocks === 1 ? "block" : "blocks"}
          {share}
        </span>
      </button>
      <span className="right">
        <Tokens
          n={row.tokens}
          basis={row.basis}
          note={output ? "The call's output tokens." : `The section's tokens${share}.`}
        />
      </span>
      <span>
        {output ? (
          <span className="cache-tag output">Output</span>
        ) : (
          <span
            className="tip-anchor cache-split"
            data-tip={`${tokens(row.cached)} tokens read from the cache, ${tokens(row.fresh)} after the cached prefix.`}
          >
            <span className="split-track" aria-hidden="true">
              <span className="split-fill" style={{ width: `${(100 * row.cached) / Math.max(1, row.tokens)}%` }} />
            </span>
            {cache}
          </span>
        )}
      </span>
      <span className="right">
        {row.costUsd !== undefined && (
          <button
            type="button"
            className="tip-anchor num"
            data-tip={
              output
                ? `${usd(row.costUsd)}: the call's output tokens at the output price. Not in the input cost above.`
                : `${usd(row.costUsd)}: the section's share of this call's input cost.`
            }
          >
            {usd(row.costUsd)}
          </button>
        )}
      </span>
    </div>
  );
}

function BlockRow({
  row,
  i,
  id,
  total,
  totalCost,
  sessionKey,
  selected,
  onOpen,
  onParts,
  onKey,
  onFocus,
}: {
  row: Extract<Row, { type: "block" }>;
  i: number;
  id: string | undefined;
  total: number;
  totalCost: number;
  sessionKey: SessionKey;
  selected: boolean;
  onOpen: () => void;
  onParts: () => void;
  onKey: (delta: number) => void;
  onFocus: () => void;
}) {
  const b = row.block;
  const source = blockSource(b);
  const kindTip = KIND_EXPLAIN[b.kind];
  const partsId = `parts-${b.position}`;
  return (
    <div
      className={selected ? "block-row selected" : "block-row"}
      data-testid="block-row"
      data-pos={b.position}
      id={id}
    >
      <span className="block-pos num muted">
        {row.parts > 0 && (
          <button
            type="button"
            className="part-toggle"
            aria-expanded={row.open}
            aria-controls={partsId}
            aria-label={`${row.open ? "Hide" : "Show"} the ${row.parts} parts of block ${b.position}`}
            onClick={onParts}
            onKeyDown={arrows(onKey)}
          >
            <span className="chevron" aria-hidden="true" />
          </button>
        )}
        {b.position}
      </span>
      <div className="part-cell">
        <button
          type="button"
          className="block-main"
          data-i={i}
          onClick={onOpen}
          onFocus={onFocus}
          onKeyDown={arrows(onKey)}
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
        {b.fromResponseOf !== undefined && (
          <Link
            className="tag answer-of"
            data-testid="response-of"
            aria-label={`Response of call ${callNumber(b.fromResponseOf)}`}
            to={{ page: "session", key: sessionKey, call: b.fromResponseOf }}
            data-tip={`The model wrote this on call ${callNumber(b.fromResponseOf)} (output price). Each later call sends it again as input.`}
          >
            <span className="wide-only">response of </span>call {callNumber(b.fromResponseOf)}
          </Link>
        )}
      </div>
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

/** One attached text of a block, indented under it: its label, its estimated share and the block's cache state. */
function PartRow({
  b,
  part,
  i,
  id,
  total,
  onOpen,
  onKey,
  onFocus,
}: {
  b: ContextBlock;
  part: ContextPart;
  i: number;
  id: string | undefined;
  total: number;
  onOpen: () => void;
  onKey: (delta: number) => void;
  onFocus: () => void;
}) {
  const teach = partTeach(part.label, part.tokens);
  return (
    <div className="block-row part-row" data-testid="part-row" data-part={part.label} id={id}>
      <span aria-hidden="true" />
      <div className="part-cell">
        <button
          type="button"
          className="block-main part-main"
          data-i={i}
          onClick={onOpen}
          onFocus={onFocus}
          onKeyDown={arrows(onKey)}
          aria-label={`Open block ${b.position}, part ${part.label}`}
          {...(teach ? { "data-tip": teach.tip } : {})}
        >
          <span className="part-branch" aria-hidden="true" />
          <span className="part-label">{part.label}</span>
          <span className="preview">{part.preview}</span>
        </button>
        {teach && <Term id={teach.term} />}
      </div>
      <span className="right">
        {part.tokens !== undefined && part.basis ? (
          <Tokens
            n={part.tokens}
            basis={part.basis}
            note={`${percent(part.tokens / total)} of the input. Its share of block ${b.position}, by characters.`}
          />
        ) : (
          <span className="muted">none</span>
        )}
      </span>
      <span className={b.inCachedPrefix ? "cache-tag cached part-cache" : "cache-tag new part-cache"}>
        {b.inCachedPrefix ? "Cached" : "New"}
      </span>
      <span aria-hidden="true" />
    </div>
  );
}

const REASONING_NOTE = {
  omitted: "omitted: the log holds only its signature",
  redacted: "redacted: the provider sent it encrypted",
} as const;

/** One block the model wrote: text, folded reasoning, or a tool call with its input in short and a link to it. */
function OutputRow({
  e,
  n,
  i,
  id,
  sessionKey,
  cwd,
  onOpen,
  onKey,
}: {
  e: ResponseEntry;
  n: number;
  i: number;
  id: string | undefined;
  sessionKey: SessionKey;
  cwd: string | undefined;
  onOpen: () => void;
  onKey: (delta: number) => void;
}) {
  const tool = e.kind === "tool-call" ? (e.toolCall?.name ?? e.source.tool ?? "tool") : undefined;
  const hidden = e.kind === "reasoning" && e.reasoning !== undefined && e.reasoning !== "full";
  const preview =
    tool !== undefined
      ? toolWords(tool, e.preview, cwd)
      : e.kind === "reasoning"
        ? hidden
          ? REASONING_NOTE[e.reasoning as "omitted" | "redacted"]
          : `folded, ${e.chars.toLocaleString("en-US")} characters`
        : e.preview;
  return (
    <div className="block-row output-row" data-testid="output-row" data-kind={e.kind} id={id}>
      <span className="block-pos num muted">{n}</span>
      <div className="part-cell">
        <button
          type="button"
          className="block-main"
          data-i={i}
          onClick={onOpen}
          onKeyDown={arrows(onKey)}
          aria-label={`Open output block ${n}: ${KIND_LABEL[e.kind]}${tool ? ` ${tool}` : ""}`}
        >
          <span className={`kind-dot cat-${e.category}`} aria-hidden="true" />
          <span className="kind">{KIND_LABEL[e.kind]}</span>
          {tool && <span className="source">{tool}</span>}
          <span className={e.kind === "reasoning" ? "preview folded" : "preview"}>{preview}</span>
        </button>
        {e.toolCall && (
          <Link className="row-link" to={{ page: "session", key: sessionKey, view: "tools", tool: e.toolCall.id }}>
            Open tool call
          </Link>
        )}
      </div>
      <span className="right">
        {e.tokens !== undefined && e.basis ? (
          <Tokens
            n={e.tokens}
            basis={e.basis}
            note={
              e.basis === "estimate" ? "Its share of the call's output tokens, by characters." : "The call's output."
            }
          />
        ) : (
          <span className="muted">none</span>
        )}
      </span>
      <span className="cache-tag output">Output</span>
      <span className="right">
        {e.costUsd !== undefined ? (
          <button
            type="button"
            className="tip-anchor num"
            data-tip={`${usd(e.costUsd)}: its tokens at the output price.`}
          >
            {usd(e.costUsd)}
          </button>
        ) : (
          <span className="muted">none</span>
        )}
      </span>
    </div>
  );
}

/** Under the output: whether it is in the log yet, why the model stopped, and which call sends it back. */
function NoteRow({
  row,
  id,
  sessionKey,
}: {
  row: Extract<Row, { type: "note" }>;
  id: string | undefined;
  sessionKey: SessionKey;
}) {
  return (
    <div className="block-row note-row" data-testid="output-note" id={id}>
      <span aria-hidden="true" />
      <p>
        {row.note === "waiting" && "The answer is not in the log yet. It shows here as soon as the harness writes it."}
        {row.note === "none" && "The log holds no answer for this call."}
        {row.note === "answered" && (
          <>
            {row.stopReason !== undefined && `${stopWords(row.stopReason)} `}
            {row.next === undefined ? (
              "The next call sends it again as input"
            ) : (
              <Link to={{ page: "session", key: sessionKey, call: row.next }} data-testid="sent-again">
                → sent again as input from call {callNumber(row.next)}
              </Link>
            )}
            . <Term id="output-tokens">Paid once here as output</Term>, then as input on each later call.
          </>
        )}
      </p>
    </div>
  );
}
