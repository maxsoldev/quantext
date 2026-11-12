/**
 * The context of Call N, exactly as the model received it: the context bar (every Block in request order, coloured
 * by category, with the hidden part and the end of the cached prefix marked), the totals by category, and the
 * ordered block list by section. Opening a Block shows all of its content.
 */
import type {
  CallContext,
  CallResponseDetail,
  ContextBlock,
  ContextCategory,
  ResponseEntry,
  SessionKey,
} from "@quantext/shared";
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { percent, shortModel, tokens, usd, when } from "../format/format.ts";
import { callNumber } from "../route.ts";
import { Term } from "../teach/Term.tsx";
import { Tokens } from "../ui/Num.tsx";
import type { Load } from "../ui/useLoad.ts";
import type { ListActions } from "./BlockList.tsx";
import { BlockList } from "./BlockList.tsx";
import { BlockPanel } from "./BlockPanel.tsx";
import { CATEGORIES, CATEGORY_LABEL } from "./categories.ts";
import type { Collapse } from "./collapse.ts";
import {
  collapseAll,
  expandAll,
  readCollapse,
  revealBlock,
  toggleBlock,
  toggleCategory,
  toggleSection,
} from "./collapse.ts";
import { KIND_LABEL } from "./kinds.ts";
import { barSegments, blockSource, hiddenPart } from "./model.ts";

/** The label of text in a block that no attached text accounts for. */
const OTHER_PART = "Other text";
const STORE = "quantext.context.open";

/** The open sections, kept in localStorage: the same on every call and after a reload. */
function useCollapse(): [Collapse, (f: (s: Collapse) => Collapse) => void] {
  const [state, setState] = useState(() => readCollapse(localStorage.getItem(STORE)));
  useEffect(() => localStorage.setItem(STORE, JSON.stringify(state)), [state]);
  return [state, setState];
}

/** An output block shown in the block panel. */
function outputBlock(e: ResponseEntry, n: number): ContextBlock {
  const b: ContextBlock = {
    position: n,
    section: "messages",
    hash: e.hash,
    kind: e.kind,
    category: e.category,
    source: e.source,
    inCachedPrefix: false,
    preview: e.preview,
    chars: e.chars,
    truncated: e.truncated,
  };
  if (e.tokens !== undefined) b.tokens = e.tokens;
  if (e.basis !== undefined) b.basis = e.basis;
  return b;
}

/** `ctx` is loaded by the page, which shares it with the diff card. */
export function ContextAt({
  sessionKey,
  call,
  ctx,
  resp,
  next,
  cwd,
  openHash,
  onOpened,
}: {
  sessionKey: SessionKey;
  call: number;
  ctx: Load<CallContext>;
  /** The Call's answer, shown as the Output section. */
  resp: Load<CallResponseDetail>;
  /** The next Call of the lane, which sends the answer back; absent for the lane's latest Call. */
  next?: number | undefined;
  /** The Session's folder: tool inputs are shown relative to it. */
  cwd?: string | undefined;
  /** A Block to open once the context is loaded (a link from a tool call). */
  openHash?: string | undefined;
  onOpened?: () => void;
}) {
  const [open, setOpen] = useState<{ block: ContextBlock; part?: number; output?: true } | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [jump, setJump] = useState<{ position: number; n: number } | undefined>(undefined);
  const [fold, setFold] = useCollapse();
  const c = ctx.value;
  useEffect(() => {
    if (!openHash || !c || c.call.index !== call) return;
    const b = c.blocks.find((x) => x.hash === openHash);
    if (b) {
      setFold((s) => revealBlock(s, b));
      setOpen({ block: b });
      setSelected(b.position);
      setJump((j) => ({ position: b.position, n: (j?.n ?? 0) + 1 }));
    }
    onOpened?.();
  }, [openHash, c, call, onOpened, setFold]);
  const act = useMemo<ListActions>(
    () => ({
      onSelect: setSelected,
      onOpen: (block, part) => setOpen(part === undefined ? { block } : { block, part }),
      onOpenOutput: (e, n) => setOpen({ block: outputBlock(e, n), output: true }),
      onFold: (f) => setFold((s) => toggleSection(s, f)),
      onParts: (b) => setFold((s) => toggleBlock(s, b)),
      onAll: (all) => setFold((s) => (all && c ? expandAll(s, c) : collapseAll())),
    }),
    [c, setFold],
  );
  const onCategory = useCallback(
    (cat: ContextCategory) => setFold((s) => (c ? toggleCategory(s, c, cat) : s)),
    [c, setFold],
  );
  const r = resp.value?.call.index === call ? resp.value : undefined;
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
          <ContextBar
            ctx={c}
            selected={selected}
            onPick={(b) => setSelected(b.position)}
            onOpen={(b) => {
              setFold((f) => revealBlock(f, b));
              setOpen({ block: b });
              setJump((j) => ({ position: b.position, n: (j?.n ?? 0) + 1 }));
            }}
          />
          <div className="context-body">
            <BlockList
              sessionKey={sessionKey}
              ctx={c}
              resp={stale ? undefined : r}
              next={next}
              cwd={cwd}
              fold={fold}
              selected={selected}
              jump={jump}
              act={act}
            />
            <CategoryTable ctx={c} fold={fold} onCategory={onCategory} />
          </div>
        </>
      ) : (
        <>
          <div className="empty">
            <h3>This call's context cannot be shown</h3>
            <p>
              The log holds this call's usage but not its request, so the blocks it sent are unknown. Its token counts
              and cost above are still exact.
            </p>
          </div>
          {r && (
            <BlockList
              sessionKey={sessionKey}
              ctx={c}
              resp={stale ? undefined : r}
              next={next}
              cwd={cwd}
              fold={fold}
              selected={selected}
              jump={jump}
              act={act}
            />
          )}
        </>
      )}
      {open && (
        <BlockPanel
          log={sessionKey.log}
          block={open.block}
          call={c.call.index}
          part={open.part}
          output={open.output}
          onClose={() => setOpen(null)}
        />
      )}
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
              ? `${KIND_LABEL[first.kind]} ${blockSource(first)}`
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

function CategoryTable({
  ctx,
  fold,
  onCategory,
}: {
  ctx: CallContext;
  fold: Collapse;
  onCategory: (cat: ContextCategory) => void;
}) {
  const total = Math.max(1, ctx.totalTokens);
  const rows = CATEGORIES.map((c) => ({ ...c, tokens: ctx.categories[c.key] })).filter((r) => r.tokens > 0);
  const subRows = (key: string) =>
    ctx.partTotals.filter((p) => p.category === key && p.tokens > 0 && p.label !== OTHER_PART);
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
          <Fragment key={r.key}>
            <tr>
              <th scope="row">
                <span className="cat-head">
                  {subRows(r.key).length > 0 && (
                    <button
                      type="button"
                      className="part-toggle"
                      aria-expanded={fold.cats.includes(r.key)}
                      aria-controls={`cat-parts-${r.key}`}
                      aria-label={`${fold.cats.includes(r.key) ? "Hide" : "Show"} the parts of ${r.label}`}
                      onClick={() => onCategory(r.key)}
                      data-testid="category-toggle"
                    >
                      <span className="chevron" aria-hidden="true" />
                    </button>
                  )}
                  <button type="button" className="tip-anchor legend-item" data-tip={r.explain}>
                    <span className={`swatch cat-${r.key}`} aria-hidden="true" />
                    {r.label}
                  </button>
                </span>
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
            {(fold.cats.includes(r.key) ? subRows(r.key) : []).map((p, k) => (
              <tr
                key={p.label}
                className="cat-sub"
                data-testid="part-total"
                {...(k === 0 ? { id: `cat-parts-${r.key}` } : {})}
              >
                <th scope="row">{p.label}</th>
                <td className="right">
                  <Tokens n={p.tokens} basis="estimate" note={`Estimated: part of ${r.label}.`} />
                </td>
                <td className="right num muted">{percent(p.tokens / total)}</td>
              </tr>
            ))}
          </Fragment>
        ))}
      </tbody>
    </table>
  );
}
