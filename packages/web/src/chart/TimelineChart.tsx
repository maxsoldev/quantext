/**
 * The Session's timeline: per Call of one lane, what the context holds (tokens stacked by category, top panel) and
 * how its input was billed (shares of cache read, cache write and uncached input, bottom panel), on one x axis. Markers:
 * compactions (a rule through both panels) and cache breaks (a triangle on the rail between them). Hover shows a
 * Call; a click or the arrow keys select one. The selected Call is outlined on its bars only, never on empty space.
 */
import type { ContextCategory, TimelineCall } from "@quantext/shared";
import type { MouseEvent, ReactNode, RefObject } from "react";
import { memo, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CachePart } from "../context/categories.ts";
import { CACHE_PARTS, CATEGORIES, CATEGORY_LABEL } from "../context/categories.ts";
import { percent, tokens, usd, when } from "../format/format.ts";
import { callNumber } from "../route.ts";
import { BREAK_REASONS } from "../teach/cacheBreaks.ts";
import type { LaneView } from "./lane.ts";
import type { Band, Stack } from "./shape.ts";
import { bandOf, niceTicks, stack, stepArea } from "./shape.ts";

const M = { left: 64, right: 16 };
/** The cache-break triangles sit in this band between the panels, above the billing panel's head. */
const MARK_H = 16;
const AXIS_H = 28;
/** A window this high or lower is "short" (a 720px projector): smaller panels, so the call cards fit too. */
export const SHORT_WINDOW = 800;

/** Panel heights: on a short window 132px and 60px, so chart, context bar and strips share one screen. */
function panelHeights(): { topH: number; bottomH: number } {
  if (innerHeight <= SHORT_WINDOW) return { topH: 132, bottomH: 60 };
  return { topH: Math.round(Math.min(260, Math.max(180, innerHeight * 0.27))), bottomH: 96 };
}

/** The plot's vertical layout, from the panel heights and the measured heights of the two head rows. */
export interface Geometry {
  top: number;
  topH: number;
  /** The y of the billing panel's head row. */
  billHead: number;
  bottomY0: number;
  bottomH: number;
  height: number;
}

function geometry(topH: number, bottomH: number, topRow: number, billRow: number): Geometry {
  const top = topRow + 6;
  const billHead = top + topH + MARK_H;
  const bottomY0 = billHead + billRow + 4;
  return { top, topH, billHead, bottomY0, bottomH, height: bottomY0 + bottomH + AXIS_H };
}

/** The height of an element, kept up to date. */
/** Both panels' y scales: the top in tokens up to the nice tick above `max`, the bottom in shares 0..1. */
function scales(g: Geometry, max: number) {
  const topTicks = niceTicks(max, g.topH < 160 ? 3 : 4);
  const topMax = topTicks.at(-1) ?? 1;
  return {
    topTicks,
    yTop: (v: number) => g.top + g.topH - (v / topMax) * g.topH,
    yBottom: (v: number) => g.bottomY0 + g.bottomH - v * g.bottomH,
  };
}

function useHeight(ref: RefObject<HTMLElement | null>, initial: number): number {
  const [h, setH] = useState(initial);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setH(el.offsetHeight));
    ro.observe(el);
    setH(el.offsetHeight);
    return () => ro.disconnect();
  }, [ref]);
  return h;
}

type TopKey = ContextCategory | "unrebuilt";
const TOP_KEYS: readonly TopKey[] = [...CATEGORIES.map((c) => c.key), "unrebuilt"];
/** The input parts only: the bottom panel shows shares of the input, so output (not input) is in the tooltip. */
const CACHE_KEYS: readonly CachePart[] = ["cacheRead", "cacheWrite", "input"];

export function inputTotal(c: TimelineCall): number {
  const u = c.usage;
  return u ? u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens : 0;
}

function topValue(c: TimelineCall, k: TopKey): number {
  if (k === "unrebuilt") return c.rebuilt ? 0 : inputTotal(c);
  return c.rebuilt ? c.categories[k] : 0;
}

/** A part's share of the Call's input, 0..1. */
function cacheShare(c: TimelineCall, k: CachePart): number {
  const total = inputTotal(c);
  return total > 0 ? cacheValue(c, k) / total : 0;
}

function cacheValue(c: TimelineCall, k: CachePart): number {
  const u = c.usage;
  if (!u) return 0;
  return k === "cacheRead"
    ? u.cacheReadTokens
    : k === "cacheWrite"
      ? u.cacheWriteTokens
      : k === "input"
        ? u.inputTokens
        : u.outputTokens;
}

export function TimelineChart({
  view,
  selected,
  onSelect,
  onBreak,
  legends,
}: {
  view: LaneView;
  /** The top legend sits in one row with its panel's name; the billing legend sits below the x axis. */
  legends: { top: ReactNode; bottom: ReactNode };
  selected: number;
  onSelect: (place: number) => void;
  /** A click on a cache-break mark: after `onSelect`, to show what changed. */
  onBreak?: (place: number) => void;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(1200);
  const [hover, setHover] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  const plotW = Math.max(100, width - M.left - M.right);
  const [heights, setHeights] = useState(panelHeights);
  useLayoutEffect(() => {
    const onResize = () => setHeights(panelHeights());
    addEventListener("resize", onResize);
    return () => removeEventListener("resize", onResize);
  }, []);
  const topRow = useRef<HTMLDivElement>(null);
  const billRow = useRef<HTMLDivElement>(null);
  const g = geometry(heights.topH, heights.bottomH, useHeight(topRow, 24), useHeight(billRow, 24));
  const band = bandOf(plotW, view.calls.length);
  const top = useMemo(() => stack(view.calls, TOP_KEYS, topValue), [view.calls]);
  const bottom = useMemo(() => stack(view.calls, CACHE_KEYS, cacheShare), [view.calls]);
  const place = (e: MouseEvent<SVGSVGElement>) => {
    const x = e.clientX - e.currentTarget.getBoundingClientRect().left - M.left;
    const p = Math.floor(x / band.step);
    return p >= 0 && p < view.calls.length ? p : null;
  };
  const xOf = (p: number) => M.left + p * band.step;
  const hovered = hover === null ? undefined : view.calls[hover];
  return (
    <div className="timeline" ref={wrap}>
      <div className="panel-head" ref={topRow} style={{ top: 0, left: M.left }}>
        <span className="panel-label">What the context holds</span>
        {legends.top}
      </div>
      <div className="panel-head" ref={billRow} style={{ top: g.billHead, left: M.left }}>
        <span className="panel-label">How the input was billed</span>
      </div>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: the keyboard picks a Call with the arrow keys and the scrubber. */}
      <svg
        width={width}
        height={g.height}
        role="img"
        aria-label={`Context per call, ${view.calls.length} calls. Use the slider below or the arrow keys to choose a call.`}
        onPointerMove={(e) => setHover(place(e))}
        onPointerLeave={() => setHover(null)}
        onClick={(e) => {
          const p = place(e);
          if (p === null) return;
          onSelect(p);
          if ((e.target as Element).closest(".break-mark")) onBreak?.(p);
        }}
        data-testid="timeline"
      >
        <Layers view={view} top={top} bottom={bottom} band={band} plotW={plotW} g={g} />
        {hover !== null && hover !== selected && <HoverBand x={xOf(hover)} w={Math.max(1, band.step)} g={g} />}
        <Selection
          x={xOf(selected) + (band.mode === "columns" ? (band.step - band.width) / 2 : 0)}
          w={Math.max(2, band.width)}
          g={g}
          y={scales(g, top.max)}
          topTotal={top.totals[selected] ?? 0}
          bottomTotal={bottom.totals[selected] ?? 0}
          round={band.mode === "columns" ? Math.min(4, band.width / 4) : 0}
          label={`Call ${callNumber(view.calls[selected]?.index ?? 0)}`}
          minX={M.left + 40}
          maxX={M.left + plotW - 40}
        />
      </svg>
      <div className="panel-foot" style={{ marginLeft: M.left, marginRight: M.right }}>
        {legends.bottom}
      </div>
      {hovered && hover !== null && <CallTip call={hovered} x={xOf(hover) + band.step / 2} width={width} />}
    </div>
  );
}

/** The marks: memoised, so hovering redraws only the cursor and the tooltip. */
const Layers = memo(function Layers({
  view,
  top,
  bottom,
  band,
  plotW,
  g,
}: {
  view: LaneView;
  top: Stack<TopKey>;
  bottom: Stack<CachePart>;
  band: Band;
  plotW: number;
  g: Geometry;
}) {
  const { topTicks, yTop, yBottom } = scales(g, top.max);
  const bottomTicks = [0, 0.5, 1];
  const { bottomY0, bottomH } = g;
  const xOf = (p: number) => M.left + p * band.step;
  const xTicks = callTicks(view.calls.length, plotW);
  return (
    <g>
      <BillPatterns />
      <Grid ticks={topTicks} y={yTop} plotW={plotW} />
      <Grid ticks={bottomTicks} y={yBottom} plotW={plotW} format={percent} />
      <Marks
        stack={top}
        y={yTop}
        band={band}
        xOf={xOf}
        cls={(k) => (k === "unrebuilt" ? "cat-unrebuilt" : `cat-${k}`)}
      />
      <Marks stack={bottom} y={yBottom} band={band} xOf={xOf} cls={(k) => `cache-${k}`} />
      {/* The billing texture: one hatch over every billing mark, so a cache part never reads as a category. */}
      <Marks stack={bottom} y={yBottom} band={band} xOf={xOf} cls={() => "bill-hatch"} />
      {view.calls.map((c, p) =>
        c.usage ? null : (
          <rect
            key={`n${c.index}`}
            className="no-usage"
            x={xOf(p) + (band.mode === "columns" ? (band.step - band.width) / 2 : 0)}
            y={g.top}
            width={Math.max(1, band.width)}
            height={bottomY0 + bottomH - g.top}
          />
        ),
      )}
      {view.compactions.map((c) => (
        <g key={`c${c.index}`} className="compaction-mark">
          <rect x={xOf(c.at) - 1} y={g.top} width={2} height={bottomY0 + bottomH - g.top} />
          <text x={xOf(c.at) + 4} y={g.top + 14}>
            Compaction
          </text>
        </g>
      ))}
      {view.breaks.map((b) => {
        const cx = xOf(b.at) + band.step / 2;
        const y = g.top + g.topH + 3;
        return (
          <path
            key={`b${b.index}`}
            className="break-mark"
            d={`M${cx - 6},${y}h12l-6,10z`}
            data-tip={`Cache break at call ${callNumber(b.index)}: ${tokens(b.dropTokens)} fewer tokens read from the cache than call ${callNumber(b.previous.index)}.\n${BREAK_REASONS[b.reason].short}\nClick to see what changed.`}
          />
        );
      })}
      {xTicks.map((p) => (
        <text key={p} className="tick" x={xOf(p) + band.step / 2} y={bottomY0 + bottomH + 20} textAnchor="middle">
          {callNumber(view.calls[p]?.index ?? 0)}
        </text>
      ))}
      <line className="baseline" x1={M.left} x2={M.left + plotW} y1={yTop(0)} y2={yTop(0)} />
      <line className="baseline" x1={M.left} x2={M.left + plotW} y1={yBottom(0)} y2={yBottom(0)} />
    </g>
  );
});

function Grid({
  ticks,
  y,
  plotW,
  format = tokens,
}: {
  ticks: number[];
  y: (v: number) => number;
  plotW: number;
  format?: (v: number) => string;
}) {
  return (
    <g>
      {ticks.slice(1).map((t) => (
        <g key={t}>
          <line className="grid" x1={M.left} x2={M.left + plotW} y1={y(t)} y2={y(t)} />
          <text className="tick" x={M.left - 8} y={y(t) + 5} textAnchor="end">
            {format(t)}
          </text>
        </g>
      ))}
      <text className="tick" x={M.left - 8} y={y(0) + 5} textAnchor="end">
        {format(0)}
      </text>
    </g>
  );
}

function Marks<K extends string>({
  stack: s,
  y,
  band,
  xOf,
  cls,
}: {
  stack: Stack<K>;
  y: (v: number) => number;
  band: Band;
  xOf: (p: number) => number;
  cls: (k: K) => string;
}) {
  if (band.mode === "area") {
    return (
      <g>
        {s.series.map((ser) => (
          <path key={ser.key} className={cls(ser.key)} d={stepArea(ser.spans, xOf, band.step, y)} />
        ))}
      </g>
    );
  }
  // Columns: 2px surface gap between stacked parts, the top part's end rounded.
  const off = (band.step - band.width) / 2;
  return (
    <g>
      {s.series.map((ser) => (
        <g key={ser.key} className={cls(ser.key)}>
          {ser.spans.map(([lo, hi], p) => {
            const h = y(lo) - y(hi);
            if (h <= 0) return null;
            const isTop = hi >= (s.totals[p] ?? 0);
            const gap = lo > 0 ? 2 : 0;
            return (
              <rect
                // biome-ignore lint/suspicious/noArrayIndexKey: one column per Call, in a fixed order.
                key={p}
                x={xOf(p) + off}
                y={y(hi)}
                width={band.width}
                height={Math.max(0.5, h - gap)}
                rx={isTop ? Math.min(4, band.width / 4) : 0}
              />
            );
          })}
        </g>
      ))}
    </g>
  );
}

/** The billing texture: one hatch over every billing mark. */
function BillPatterns() {
  return (
    <defs>
      <pattern id="bill-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
        <line x1="0" y1="0" x2="0" y2="6" />
      </pattern>
    </defs>
  );
}

/** The hovered Call: a light tint over each panel, not over the gap between them. */
function HoverBand({ x, w, g }: { x: number; w: number; g: Geometry }) {
  return (
    <g className="cursor" pointerEvents="none">
      <rect x={x} y={g.top} width={w} height={g.topH} />
      <rect x={x} y={g.bottomY0} width={w} height={g.bottomH} />
    </g>
  );
}

/**
 * The selected Call: an outline around each of its bars (top: 0 to its total, bottom: 0 to 100%), so the frame
 * never covers empty space. A Call with no usage has no bars: its placeholder gets a dashed outline.
 */
function Selection({
  x,
  w,
  g,
  y,
  topTotal,
  bottomTotal,
  round,
  label,
  minX,
  maxX,
}: {
  x: number;
  w: number;
  g: Geometry;
  y: { yTop: (v: number) => number; yBottom: (v: number) => number };
  topTotal: number;
  bottomTotal: number;
  round: number;
  label: string;
  minX: number;
  maxX: number;
}) {
  const box = (y0: number, y1: number, key: string) => (
    <rect key={key} x={x - 2} y={y1 - 2} width={w + 4} height={y0 - y1 + 4} rx={round + 2} />
  );
  const empty = topTotal <= 0 && bottomTotal <= 0;
  return (
    <g className="cursor selected" pointerEvents="none" data-testid="selection">
      {empty ? (
        <rect className="selection-empty" x={x - 2} y={g.top} width={w + 4} height={g.bottomY0 + g.bottomH - g.top} />
      ) : (
        [
          topTotal > 0 && box(y.yTop(0), y.yTop(topTotal), "top"),
          bottomTotal > 0 && box(y.yBottom(0), y.yBottom(bottomTotal), "bottom"),
        ]
      )}
      <AxisLabel x={x + w / 2} y={g.bottomY0 + g.bottomH} label={label} minX={minX} maxX={maxX} />
    </g>
  );
}

/** The selected Call's name on the x axis, on a pill that covers the ticks under it. */
function AxisLabel({ x, y, label, minX, maxX }: { x: number; y: number; label: string; minX: number; maxX: number }) {
  const w = label.length * 8.5 + 16;
  const left = Math.min(Math.max(x - w / 2, minX - 40), maxX + 40 - w);
  return (
    <g className="cursor-label">
      <rect x={left} y={y + 4} width={w} height={22} rx={4} />
      <text x={left + w / 2} y={y + 20} textAnchor="middle">
        {label}
      </text>
    </g>
  );
}

/** About one label per 80px, at round steps of Calls. */
function callTicks(count: number, plotW: number): number[] {
  if (count === 0) return [];
  const want = Math.max(1, Math.floor(plotW / 80));
  const raw = count / want;
  const mag = 10 ** Math.floor(Math.log10(Math.max(1, raw)));
  const step = Math.max(1, ([1, 2, 5, 10].find((m) => m * mag >= raw) ?? 10) * mag);
  const out: number[] = [];
  for (let p = 0; p < count; p += step) out.push(p);
  return out;
}

function CallTip({ call, x, width }: { call: TimelineCall; x: number; width: number }) {
  const box = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const w = el.offsetWidth;
    el.style.left = `${x + 16 + w > width ? x - 16 - w : x + 16}px`;
  });
  const total = inputTotal(call);
  const cats = call.rebuilt
    ? CATEGORIES.filter((c) => call.categories[c.key] > 0).map((c) => [c.key, call.categories[c.key]] as const)
    : [];
  return (
    <div ref={box} className="chart-tip" role="status" data-testid="chart-tip">
      <div className="chart-tip-head">
        <b>Call {callNumber(call.index)}</b>
        <span className="muted">{when(call.ts)}</span>
      </div>
      <div className="chart-tip-total">
        {!call.usage && <b>No usage in the log: its tokens and cost are unknown. </b>}
        <b className="num">{tokens(total)}</b> input tokens{call.usage?.basis === "derived" ? " (Δ derived)" : ""}
        {call.cost && <span className="muted">, {usd(call.cost.totalUsd)}</span>}
      </div>
      {call.rebuilt ? (
        <ul className="tip-rows">
          {cats.map(([k, v]) => (
            <li key={k}>
              <span className={`swatch cat-${k}`} />
              <span>{CATEGORY_LABEL[k]}</span>
              <span className="num">{tokens(v)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">The log holds no request for this call: its context is not rebuilt.</p>
      )}
      <ul className="tip-rows">
        {CACHE_PARTS.map((p) => (
          <li key={p.key}>
            <span className={`swatch cache-${p.key}`} />
            <span>{p.label}</span>
            <span className="num">
              {tokens(cacheValue(call, p.key))}
              {p.key !== "output" && inputTotal(call) > 0 && (
                <span className="muted"> ({percent(cacheShare(call, p.key))})</span>
              )}
            </span>
          </li>
        ))}
      </ul>
      <p className="muted chart-tip-hint">Click to open this call's context</p>
    </div>
  );
}
