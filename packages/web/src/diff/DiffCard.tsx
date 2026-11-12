/**
 * What changed at Call N against the Call before it: two strips on one scale (unchanged blocks grey, changes in
 * their category colour), the end of each cached prefix, and the changed blocks in a list. At a cache break it
 * says why the cache broke and what to do about it.
 */
import type { CacheBreak, CallContext, ContextBlock, ContextDiff, SessionKey } from "@quantext/shared";
import type { KeyboardEvent } from "react";
import { useMemo, useState } from "react";
import { BlockPanel } from "../context/BlockPanel.tsx";
import { CATEGORY_LABEL } from "../context/categories.ts";
import { KIND_LABEL } from "../context/kinds.ts";
import { sourceLabel } from "../context/model.ts";
import { count, duration, shortModel, tokens } from "../format/format.ts";
import { callNumber } from "../route.ts";
import { BREAK_REASONS } from "../teach/cacheBreaks.ts";
import { Term } from "../teach/Term.tsx";
import { Tokens } from "../ui/Num.tsx";
import type { Load } from "../ui/useLoad.ts";
import type { ChangeStatus, DiffView, Strip, StripSegment } from "./model.ts";
import { breakSummary, diffView } from "./model.ts";

const STATUS_LABEL: Record<ChangeStatus, string> = {
  kept: "Unchanged",
  added: "Added",
  removed: "Removed",
  moved: "Moved",
};

type Change = { block: ContextBlock; status: ChangeStatus | "rewritten"; call: number };

export function DiffCard({
  sessionKey,
  ctx,
  diff,
  prev,
  breaks,
  onGoTo,
}: {
  sessionKey: SessionKey;
  ctx: CallContext | undefined;
  diff: Load<ContextDiff>;
  prev: CallContext | undefined;
  /** The cache breaks of the lane, to link and to explain the one at this Call. */
  breaks: readonly CacheBreak[];
  onGoTo: (call: number) => void;
}) {
  const [open, setOpen] = useState<{ block: ContextBlock; call: number } | null>(null);
  const d = diff.value;
  const view = useMemo(
    () => (d && ctx && ctx.rebuilt && d.call === ctx.call.index ? diffView(prev, ctx, d) : undefined),
    [d, ctx, prev],
  );
  const here = d ? breaks.find((b) => b.index === d.call) : undefined;
  return (
    <section className="card diff-card" id="what-changed" aria-labelledby="diff-title" data-testid="diff">
      <div className="diff-head">
        <h2 id="diff-title">
          What changed at call <span className="num">{callNumber(d?.call ?? ctx?.call.index ?? 0)}</span>
        </h2>
        {d?.previous !== undefined && ctx && prev && (
          <p className="muted">
            against call {callNumber(d.previous)}
            {d.modelSwitch ? `, which ran on ${shortModel(prev.call.model)}` : ""},{" "}
            {duration(Math.max(0, Date.parse(ctx.call.ts) - Date.parse(prev.call.ts)))} before
          </p>
        )}
      </div>
      {diff.state === "error" && !d && (
        <p className="error" role="alert">
          The change at this call could not be read: {diff.error.message}
        </p>
      )}
      {!d && diff.state === "loading" && <p className="muted">Comparing with the call before…</p>}
      {d && ctx && !ctx.rebuilt && (
        <p className="muted">
          This call's request is not in the log, so its blocks cannot be compared. Its usage above is still exact.
        </p>
      )}
      {d && here && <BreakNote b={here} />}
      {d && view && !here && <Lede d={d} view={view} ctx={ctx} />}
      {d && view && d.previous !== undefined && <Strips d={d} view={view} />}
      {d && view && <Changes d={d} onOpen={setOpen} />}
      {breaks.length > 0 && <BreakNav breaks={breaks} call={d?.call ?? ctx?.call.index ?? 0} onGoTo={onGoTo} />}
      {open && <BlockPanel log={sessionKey.log} block={open.block} call={open.call} onClose={() => setOpen(null)} />}
    </section>
  );
}

function BreakNav({
  breaks,
  call,
  onGoTo,
}: {
  breaks: readonly CacheBreak[];
  call: number;
  onGoTo: (call: number) => void;
}) {
  const s = breakSummary(breaks, call);
  return (
    <p className="diff-breaks" data-testid="break-nav">
      <Term id="cache-break">{count(breaks.length, "cache break")}</Term> in this lane:{" "}
      {s.counts.map(([reason, n]) => `${n} ${BREAK_REASONS[reason].title.toLowerCase()}`).join(", ")}.{" "}
      {s.previous && (
        <button type="button" className="link" onClick={() => onGoTo((s.previous as CacheBreak).index)}>
          Previous: call {callNumber(s.previous.index)}
        </button>
      )}
      {s.previous && s.next && " "}
      {s.next && (
        <button type="button" className="link" onClick={() => onGoTo((s.next as CacheBreak).index)}>
          Next: call {callNumber(s.next.index)}
        </button>
      )}
    </p>
  );
}

function BreakNote({ b }: { b: CacheBreak }) {
  const r = BREAK_REASONS[b.reason];
  return (
    <div className="break-note" data-testid="break-note">
      <p className="break-title">
        <span className="break-icon" aria-hidden="true" />
        <b>Cache break: {r.title}.</b> The cache read fell from{" "}
        <Tokens
          n={b.previous.cacheReadTokens}
          note={`Call ${callNumber(b.previous.index)}'s usage: cache read tokens.`}
        />{" "}
        to <Tokens n={b.cacheReadTokens} note="This call's usage: cache read tokens." /> tokens, and{" "}
        <Tokens n={b.cacheWriteTokens} note="This call's usage: cache write tokens." /> tokens were written to the cache
        {b.gapSeconds >= 60 ? `, ${duration(b.gapSeconds * 1000)} after the call before` : ""}.
      </p>
      <p>{r.what}</p>
      <p>
        <b>What to do.</b> {r.todo}
      </p>
    </div>
  );
}

function Lede({ d, view, ctx }: { d: ContextDiff; view: DiffView; ctx: CallContext | undefined }) {
  const read = ctx?.call.usage?.cacheReadTokens ?? 0;
  if (d.previous === undefined) {
    return (
      <p className="diff-lede">
        The first call of its lane: all <Tokens n={view.totals.added.tokens} note="The blocks of this call." /> tokens
        of its input are new, so the provider wrote them to the cache.
      </p>
    );
  }
  const { added, removed } = view.totals;
  if (added.blocks === 0 && removed.blocks === 0 && d.moved.length === 0) {
    return <p className="diff-lede">Nothing changed: this call sent the same blocks as the call before.</p>;
  }
  return (
    <p className="diff-lede">
      {added.blocks > 0 && (
        <>
          {added.blocks} {added.blocks === 1 ? "block" : "blocks"} (
          <Tokens n={added.tokens} note="The tokens of the added blocks." />) added
        </>
      )}
      {added.blocks > 0 && removed.blocks > 0 && ", "}
      {removed.blocks > 0 && (
        <>
          {removed.blocks} removed (<Tokens n={removed.tokens} note="Their tokens in the call before." />)
        </>
      )}
      {d.firstChange !== undefined && <> from position {d.firstChange} on</>}.{" "}
      {read > 0 ? (
        <>
          Everything before that was the same, so <Tokens n={read} note="This call's usage: cache read tokens." />{" "}
          tokens were read from the cache.
        </>
      ) : (
        "Nothing was read from the cache."
      )}
    </p>
  );
}

function Strips({ d, view }: { d: ContextDiff; view: DiffView }) {
  return (
    <div className="diff-strips">
      <StripRow
        label={d.previous === undefined ? "Before" : `Call ${callNumber(d.previous)}`}
        strip={view.before}
        testId="strip-before"
      />
      <StripRow label={`Call ${callNumber(d.call)}`} strip={view.now} testId="strip-now" />
      <ul className="legend" aria-label="What the strips show">
        <li>
          <span className="swatch diff-kept" aria-hidden="true" />
          Unchanged
        </li>
        <li>
          <span className="swatch diff-changed" aria-hidden="true" />
          Added or removed, in its category colour
        </li>
        <li>
          <span className="swatch diff-moved-swatch" aria-hidden="true" />
          Moved
        </li>
        <li>
          <span className="swatch diff-rewritten" aria-hidden="true" />
          Unchanged, but written to the cache again
        </li>
        <li>
          <span className="swatch diff-cached-swatch" aria-hidden="true" />
          End of the cached prefix
        </li>
      </ul>
    </div>
  );
}

function StripRow({ label, strip, testId }: { label: string; strip: Strip; testId: string }) {
  const [active, setActive] = useState(0);
  const at = Math.min(active, Math.max(0, strip.segments.length - 1));
  // One tab stop per strip; the arrow keys, Home and End move between its segments (each shows its tooltip).
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const last = strip.segments.length - 1;
    const next =
      e.key === "ArrowRight"
        ? Math.min(last, at + 1)
        : e.key === "ArrowLeft"
          ? Math.max(0, at - 1)
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? last
              : undefined;
    if (next === undefined) return;
    e.preventDefault();
    setActive(next);
    e.currentTarget.querySelectorAll<HTMLElement>(".diff-seg")[next]?.focus();
  };
  return (
    <div className="diff-row">
      <span className="diff-label num">{label}</span>
      <div
        className="diff-strip"
        data-testid={testId}
        role="toolbar"
        aria-label={`${label}: its blocks in order. Arrow keys move between them.`}
        onKeyDown={onKey}
      >
        {strip.segments.map((s, i) => {
          const tip = segmentTip(s);
          return (
            <button
              type="button"
              key={s.block.position}
              className={`diff-seg ${s.status === "kept" ? (s.rewritten ? "diff-rewritten" : "diff-kept") : `cat-${s.category}`}${s.status === "moved" ? " diff-moved" : ""}`}
              style={{ left: `${s.left}%`, width: `${s.width}%` }}
              data-status={s.status}
              data-blocks={s.blocks.length}
              data-tip={tip}
              aria-label={tip}
              tabIndex={i === at ? 0 : -1}
              onFocus={() => setActive(i)}
            />
          );
        })}
        {strip.cachedTo > 0 && <span className="diff-cached" style={{ left: `${strip.cachedTo}%` }} />}
        {strip.firstChange !== undefined && (
          <span
            className={strip.firstChange > 80 ? "diff-first flip" : "diff-first"}
            style={{ left: `${strip.firstChange}%` }}
          >
            <span>first change</span>
          </span>
        )}
      </div>
    </div>
  );
}

/** A segment's tooltip: the Block's name, category and tokens; for a merged run, its Blocks (the first few). */
function segmentTip(s: StripSegment): string {
  const state = `${STATUS_LABEL[s.status]}${s.rewritten ? ", written to the cache again" : ""}`;
  const name = (b: ContextBlock) => [KIND_LABEL[b.kind], sourceLabel(b.source)].filter(Boolean).join(" ");
  if (s.blocks.length === 1) {
    return `${name(s.block)}\n${CATEGORY_LABEL[s.category]}, ${tokens(s.tokens)} tokens\n${state}, position ${s.block.position}`;
  }
  const shown = s.blocks.slice(0, 6).map((b) => `  ${name(b)}: ${tokens(b.tokens ?? 0)}`);
  const more = s.blocks.length - shown.length;
  return [
    `${s.blocks.length} small blocks, ${tokens(s.tokens)} tokens`,
    `${CATEGORY_LABEL[s.category]}`,
    `${state}, positions ${s.block.position} to ${s.blocks.at(-1)?.position}`,
    ...shown,
    ...(more > 0 ? [`  and ${more} more`] : []),
  ].join("\n");
}

function Changes({ d, onOpen }: { d: ContextDiff; onOpen: (o: { block: ContextBlock; call: number }) => void }) {
  const rows: Change[] = [
    ...d.added.map((block) => ({ block, status: "added" as const, call: d.call })),
    ...d.removed.map((block) => ({ block, status: "removed" as const, call: d.previous ?? d.call })),
    ...d.moved.map((block) => ({ block, status: "moved" as const, call: d.call })),
    ...d.uncached.map((block) => ({ block, status: "rewritten" as const, call: d.call })),
  ];
  if (rows.length === 0) return null;
  return (
    <details className="diff-changes" open={rows.length <= 8}>
      <summary>
        {rows.length} {rows.length === 1 ? "change" : "changes"}, by block
      </summary>
      <ul className="change-list" data-testid="change-list">
        {rows.map((r) => (
          <li key={`${r.status}-${r.block.position}`}>
            <button
              type="button"
              className="change-row"
              onClick={() => onOpen({ block: r.block, call: r.call })}
              aria-label={`Open block: ${r.status} ${KIND_LABEL[r.block.kind]}`}
            >
              <span className={`change-tag change-${r.status}`}>
                {r.status === "rewritten" ? "Written again" : STATUS_LABEL[r.status]}
              </span>
              <span className="num muted">
                {"from" in r.block ? `${(r.block as { from: number }).from} → ` : ""}
                {r.block.position}
              </span>
              <span className={`kind-dot cat-${r.block.category}`} aria-hidden="true" />
              <span className="kind">{KIND_LABEL[r.block.kind]}</span>
              <span className="source">{sourceLabel(r.block.source)}</span>
              <span className="preview">{r.block.preview}</span>
              <span className="num right">{tokens(r.block.tokens ?? 0)}</span>
            </button>
          </li>
        ))}
      </ul>
    </details>
  );
}
