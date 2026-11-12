/**
 * The Session's timeline: per Call of one lane, what the context holds (tokens stacked by category, top panel) and
 * how its input was billed (shares of cache read, cache write and uncached input, bottom panel), on one x axis. Markers:
 * compactions (a rule through both panels) and cache breaks (a triangle on the rail between them). Hover shows a
 * Call; a click or the arrow keys select one.
 */
import type { ContextCategory, TimelineCall } from "@quantext/shared";
import type { MouseEvent } from "react";
import { memo, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CachePart } from "../context/categories.ts";
import { CACHE_PARTS, CATEGORIES, CATEGORY_LABEL } from "../context/categories.ts";
import { percent, tokens, usd, when } from "../format/format.ts";
import type { LaneView } from "./lane.ts";
import type { Band, Stack } from "./shape.ts";
import { bandOf, niceTicks, stack, stepArea } from "./shape.ts";

const M = { left: 64, right: 16, top: 30 };
const RAIL_H = 44;
const BOTTOM_H = 96;
const AXIS_H = 28;
/** The top panel's height: smaller on a short window (a 720px projector) so the scrubber stays in view. */
function topHeight(): number {
  return Math.round(Math.min(260, Math.max(160, innerHeight * 0.27)));
}

type TopKey = ContextCategory | "unrebuilt";
const TOP_KEYS: readonly TopKey[] = [...CATEGORIES.map((c) => c.key), "unrebuilt"];
/** The input parts only: the bottom panel shows shares of the input, so output (not input) is in the tooltip. */
const CACHE_KEYS: readonly CachePart[] = ["cacheRead", "cacheWrite", "input"];

export const REASONS: Record<string, string> = {
  compaction: "A compaction replaced the context, so the cached prefix no longer matches.",
  "model-switch": "Another model: each model has its own cache.",
  ttl: "The cache expired: more time passed since the previous call than the cache lives (5 min or 1 h).",
  "prefix-change":
    "Something early in the request changed (a tool list, the system prompt, an edited message), so the cache matched only up to there.",
};

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
}: {
  view: LaneView;
  selected: number;
  onSelect: (place: number) => void;
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
  const [topH, setTopH] = useState(topHeight);
  useLayoutEffect(() => {
    const onResize = () => setTopH(topHeight());
    addEventListener("resize", onResize);
    return () => removeEventListener("resize", onResize);
  }, []);
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
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: the keyboard picks a Call with the arrow keys and the scrubber. */}
      <svg
        width={width}
        height={M.top + topH + RAIL_H + BOTTOM_H + AXIS_H}
        role="img"
        aria-label={`Context per call, ${view.calls.length} calls. Use the slider below or the arrow keys to choose a call.`}
        onPointerMove={(e) => setHover(place(e))}
        onPointerLeave={() => setHover(null)}
        onClick={(e) => {
          const p = place(e);
          if (p !== null) onSelect(p);
        }}
        data-testid="timeline"
      >
        <Layers view={view} top={top} bottom={bottom} band={band} plotW={plotW} topH={topH} />
        <Cursor
          x={xOf(selected) + (band.mode === "columns" ? (band.step - band.width) / 2 : 0)}
          w={Math.max(2, band.width)}
          h={topH + RAIL_H + BOTTOM_H}
          label={`Call ${view.calls[selected]?.index ?? ""}`}
          minX={M.left + 40}
          maxX={M.left + plotW - 40}
          selected
        />
        {hover !== null && hover !== selected && (
          <Cursor x={xOf(hover)} w={Math.max(1, band.step)} h={topH + RAIL_H + BOTTOM_H} label="" />
        )}
      </svg>
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
  topH,
}: {
  view: LaneView;
  top: Stack<TopKey>;
  bottom: Stack<CachePart>;
  band: Band;
  plotW: number;
  topH: number;
}) {
  const TOP_H = topH;
  const topTicks = niceTicks(top.max, 4);
  const bottomTicks = [0, 0.5, 1];
  const yTop = (v: number) => M.top + TOP_H - (v / (topTicks.at(-1) ?? 1)) * TOP_H;
  const bottomY0 = M.top + TOP_H + RAIL_H;
  const yBottom = (v: number) => bottomY0 + BOTTOM_H - (v / (bottomTicks.at(-1) ?? 1)) * BOTTOM_H;
  const xOf = (p: number) => M.left + p * band.step;
  const xTicks = callTicks(view.calls.length, plotW);
  return (
    <g>
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
      <text className="panel-label" x={M.left} y={M.top - 12}>
        What the context holds
      </text>
      <text className="panel-label" x={M.left} y={bottomY0 - 4}>
        How the input was billed
      </text>
      {view.compactions.map((c) => (
        <g key={`c${c.index}`} className="compaction-mark">
          <rect x={xOf(c.at) - 1} y={M.top} width={2} height={TOP_H + RAIL_H + BOTTOM_H} />
          <text x={xOf(c.at) + 4} y={M.top + 14}>
            Compaction
          </text>
        </g>
      ))}
      {view.breaks.map((b) => {
        const cx = xOf(b.at) + band.step / 2;
        const y = M.top + TOP_H + 4;
        return (
          <path
            key={`b${b.index}`}
            className="break-mark"
            d={`M${cx - 6},${y}h12l-6,10z`}
            data-tip={`Cache break at call ${b.index}: ${tokens(b.dropTokens)} fewer tokens read from the cache than call ${b.previous.index}.\n${REASONS[b.reason] ?? b.reason}`}
          />
        );
      })}
      {xTicks.map((p) => (
        <text key={p} className="tick" x={xOf(p) + band.step / 2} y={bottomY0 + BOTTOM_H + 20} textAnchor="middle">
          {view.calls[p]?.index}
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

function Cursor({
  x,
  w,
  h,
  label,
  selected = false,
  minX = 0,
  maxX = Number.POSITIVE_INFINITY,
}: {
  x: number;
  w: number;
  h: number;
  label: string;
  selected?: boolean;
  minX?: number;
  maxX?: number;
}) {
  return (
    <g className={selected ? "cursor selected" : "cursor"} pointerEvents="none">
      <rect x={x} y={M.top} width={w} height={h} />
      {label && (
        <text
          x={x + w / 2 > maxX ? x + w : x + w / 2 < minX ? x : x + w / 2}
          y={M.top - 12}
          textAnchor={x + w / 2 > maxX ? "end" : x + w / 2 < minX ? "start" : "middle"}
          className="cursor-label"
        >
          {label}
        </text>
      )}
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
        <b>Call {call.index}</b>
        <span className="muted">{when(call.ts)}</span>
      </div>
      <div className="chart-tip-total">
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
