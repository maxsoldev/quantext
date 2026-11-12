/** Shaping a Call's context for the viewer: the rows of its block list, its hidden part, a Block's source in words. */
import type {
  BlockSource,
  CallContext,
  CallResponseDetail,
  ContextBlock,
  ContextCategory,
  ContextPart,
  ContextTurn,
  PartTotal,
  ResponseEntry,
  TokenBasis,
} from "@quantext/shared";
import type { Part } from "./categories.ts";
import { CATEGORIES } from "./categories.ts";
import type { Collapse, Fold } from "./collapse.ts";
import { KIND_LABEL } from "./kinds.ts";

/** A section's header: what it holds, open or not. Output has no cache split. */
export interface SectionHead {
  type: "section";
  section: Fold;
  open: boolean;
  blocks: number;
  tokens: number;
  basis: TokenBasis;
  /** Tokens in the cached prefix, and after it. */
  cached: number;
  fresh: number;
  costUsd?: number;
}

/** The earlier turns of the messages, as one row that sums them. */
export interface EarlierHead {
  type: "earlier";
  open: boolean;
  turns: number;
  blocks: number;
  tokens: number;
  basis: TokenBasis;
  cached: number;
}

export type Row =
  | SectionHead
  | EarlierHead
  /** A turn's header: an earlier one folds; `current` is the call's own turn, always open. */
  | { type: "turn"; turn: ContextTurn; key: string; open: boolean; current: boolean; basis: TokenBasis }
  | { type: "block"; block: ContextBlock; parts: number; open: boolean }
  | { type: "part"; block: ContextBlock; part: ContextPart }
  | { type: "output"; entry: ResponseEntry; n: number }
  /** Under the output: still waiting, never logged, or which call sends it back. */
  | { type: "note"; note: "waiting" | "none" | "answered"; next?: number; stopReason?: string };

const ORDER = ["tools", "system", "messages"] as const;
const WEAK: Record<TokenBasis, number> = { exact: 0, anchored: 1, derived: 2, estimate: 3 };

/** The least exact basis of the blocks: the one that a sum of them has. */
function weakest(blocks: readonly ContextBlock[]): TokenBasis {
  let out: TokenBasis = "exact";
  for (const b of blocks) if (b.basis && b.basis !== "framing" && WEAK[b.basis] > WEAK[out]) out = b.basis;
  return out;
}

/** The key that keeps a turn open across calls: its prompt's hash, else its first block's. */
export function turnKey(ctx: CallContext, t: ContextTurn): string {
  const at = (p: number) => ctx.blocks[p]?.hash;
  return (t.prompt && at(t.prompt.position)) ?? at(t.start) ?? `turn-${t.start}`;
}

/**
 * The sections in request order, each with a header row and, when open, its blocks, each followed by its parts
 * when it has more than one and they are shown; the framing tokens go last, shown with the messages. With more
 * than one turn, the messages' earlier turns fold into one row, then a row each, and the call's own turn is open.
 * `find` keeps the blocks whose kind, source, preview or part matches (case does not count), with only the parts
 * that match when any does; `only` keeps the blocks at those positions. Both open what they find in. Without
 * `fold`, all is open.
 */
export function listRows(ctx: CallContext, find = "", fold?: Collapse, only?: ReadonlySet<number>): Row[] {
  const needle = find.trim().toLowerCase();
  const filtered = needle !== "" || only !== undefined;
  const has = (...texts: string[]) => texts.some((t) => t.toLowerCase().includes(needle));
  const blockRows = (block: ContextBlock): Row[] => {
    if (only !== undefined && !only.has(block.position)) return [];
    const parts = (block.parts?.length ?? 0) > 1 ? (block.parts ?? []) : [];
    const own = has(KIND_LABEL[block.kind], blockSource(block), block.preview);
    const hits = needle === "" ? [] : parts.filter((p) => has(p.label, p.preview));
    if (needle !== "" && !own && hits.length === 0) return [];
    const open = fold === undefined || (block.hash !== undefined && fold.blocks.includes(block.hash));
    const shown = hits.length > 0 ? hits : open ? parts : [];
    const head: Row = { type: "block", block, parts: parts.length, open: shown.length > 0 };
    return [head, ...shown.map((part): Row => ({ type: "part", block, part }))];
  };
  const rows: Row[] = [];
  for (const section of ORDER) {
    const blocks = ctx.blocks.filter((b) => b.section === section);
    const shown = section === "messages" ? turnRows(ctx, blocks, blockRows, filtered, fold) : blocks.flatMap(blockRows);
    if (shown.length === 0) continue;
    const open = filtered || fold === undefined || fold.open[section];
    const sum = (f: (b: ContextBlock) => number) => blocks.reduce((n, b) => n + f(b), 0);
    const cached = sum((b) => (b.inCachedPrefix ? (b.tokens ?? 0) : 0));
    const head: SectionHead = {
      type: "section",
      section,
      open,
      blocks: blocks.length,
      tokens: ctx.sections[section],
      basis: weakest(blocks),
      cached,
      fresh: ctx.sections[section] - cached,
    };
    if (blocks.some((b) => b.costUsd !== undefined)) head.costUsd = sum((b) => b.costUsd ?? 0);
    rows.push(head, ...(open ? shown : []));
  }
  const framing = filtered || fold === undefined || fold.open.messages;
  for (const block of ctx.blocks.filter((b) => b.section === "framing" && framing)) rows.push(...blockRows(block));
  return rows;
}

/**
 * The messages' rows by turn: the earlier turns' row, a row per earlier turn when it is open, the blocks of each
 * open turn, then the call's own turn. A filter shows only the turns it finds in, open. One turn: just its blocks.
 */
function turnRows(
  ctx: CallContext,
  blocks: readonly ContextBlock[],
  blockRows: (b: ContextBlock) => Row[],
  filtered: boolean,
  fold: Collapse | undefined,
): Row[] {
  const turns = ctx.turns ?? [];
  if (turns.length < 2) return blocks.flatMap(blockRows);
  const byTurn = new Map<number, ContextBlock[]>();
  for (const b of blocks) {
    const list = byTurn.get(b.turn ?? 0);
    if (list) list.push(b);
    else byTurn.set(b.turn ?? 0, [b]);
  }
  const earlier = turns.slice(0, -1);
  const current = turns.at(-1) as ContextTurn;
  // Collapsed groups draw nothing, so their block rows are built only when shown or filtered.
  const inner = (t: ContextTurn) => (byTurn.get(t.turn) ?? []).flatMap(blockRows);
  const rows: Row[] = [];
  const open = filtered || fold === undefined || fold.earlier;
  const earlierRows: Row[] = [];
  if (open) {
    for (const t of earlier) {
      const key = turnKey(ctx, t);
      const shown = filtered || fold === undefined || fold.turns.includes(key) ? inner(t) : [];
      if (filtered && shown.length === 0) continue;
      const basis = weakest(byTurn.get(t.turn) ?? []);
      earlierRows.push({ type: "turn", turn: t, key, open: shown.length > 0, current: false, basis }, ...shown);
    }
  }
  if (!filtered || earlierRows.length > 0) {
    const sum = (f: (t: ContextTurn) => number) => earlier.reduce((n, t) => n + f(t), 0);
    rows.push(
      {
        type: "earlier",
        open,
        turns: earlier.length,
        blocks: sum((t) => t.blocks),
        tokens: sum((t) => t.tokens),
        basis: weakest(earlier.flatMap((t) => byTurn.get(t.turn) ?? [])),
        cached: sum((t) => t.cachedTokens),
      },
      ...earlierRows,
    );
  }
  const own = inner(current);
  if (!filtered || own.length > 0) {
    const basis = weakest(byTurn.get(current.turn) ?? []);
    rows.push({ type: "turn", turn: current, key: turnKey(ctx, current), open: true, current: true, basis }, ...own);
  }
  return rows;
}

/**
 * The Output section: what the model answered, a row per Block, then a note (waiting, none logged, or the stop
 * reason and the call that sends it back). Not part of the input. `find` filters as in the input; `resp` absent
 * while it loads gives no rows.
 */
export function outputRows(
  resp: CallResponseDetail | undefined,
  { find = "", open = true, next }: { find?: string; open?: boolean; next?: number | undefined } = {},
): Row[] {
  if (resp === undefined) return [];
  const needle = find.trim().toLowerCase();
  const has = (...texts: string[]) => texts.some((t) => t.toLowerCase().includes(needle));
  const entries = resp.blocks.filter(
    (e) => needle === "" || has(KIND_LABEL[e.kind], e.toolCall?.name ?? "", sourceLabel(e.source), e.preview),
  );
  if (needle !== "" && entries.length === 0) return [];
  const head: SectionHead = {
    type: "section",
    section: "output",
    open: open || needle !== "",
    blocks: resp.blocks.length,
    tokens: resp.outputTokens ?? 0,
    basis: resp.call.usage?.basis ?? "exact",
    cached: 0,
    fresh: resp.outputTokens ?? 0,
  };
  if (resp.outputUsd !== undefined) head.costUsd = resp.outputUsd;
  if (!head.open) return [head];
  const note: Row = resp.answered
    ? {
        type: "note",
        note: "answered",
        ...(next === undefined ? {} : { next }),
        ...(resp.stopReason === undefined ? {} : { stopReason: resp.stopReason }),
      }
    : { type: "note", note: next === undefined ? "waiting" : "none" };
  return [head, ...entries.map((entry): Row => ({ type: "output", entry, n: resp.blocks.indexOf(entry) + 1 })), note];
}

/**
 * A block's source in words: by its part when one attached text is all of it and the log tells nothing finer, or
 * the number of attached texts it holds.
 */
export function blockSource(b: ContextBlock): string {
  const s = sourceLabel(b.source);
  const parts = b.parts ?? [];
  const [only] = parts;
  if (parts.length === 1 && only !== undefined && s === (b.source.attachment ?? "")) return only.label;
  const attached = parts.filter((p) => p.source.attachment !== undefined).length;
  return s === "" && parts.length > 1 ? `${attached} attached texts` : s;
}

/** The label of text in a block that no attached text accounts for. */
const OTHER_PART = "Other text";

/**
 * The token-share table: the categories that hold tokens, largest share first (ties in the categories' order),
 * each with its part totals the same way, without the text no attached text accounts for.
 */
export function shareRows(ctx: CallContext): (Part<ContextCategory> & { tokens: number; parts: PartTotal[] })[] {
  return CATEGORIES.map((c) => ({
    ...c,
    tokens: ctx.categories[c.key] ?? 0,
    parts: ctx.partTotals
      .filter((p) => p.category === c.key && p.tokens > 0 && p.label !== OTHER_PART)
      .sort((a, b) => b.tokens - a.tokens),
  }))
    .filter((r) => r.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens);
}

/** The tool schemas and the system prompt: sent before the first message, never shown in the chat. */
export function hiddenPart(ctx: CallContext): { tools: number; system: number; tokens: number; share: number } {
  const tokens = ctx.sections.tools + ctx.sections.system;
  return {
    tools: ctx.sections.tools,
    system: ctx.sections.system,
    tokens,
    share: ctx.totalTokens ? tokens / ctx.totalTokens : 0,
  };
}

/** The most specific thing the log tells about where a Block came from. */
export function sourceLabel(s: BlockSource): string {
  if (s.mcpServer) {
    const prefix = `mcp__${s.mcpServer}__`;
    const tool = s.tool?.startsWith(prefix) ? s.tool.slice(prefix.length) : s.tool;
    return tool ? `MCP ${s.mcpServer}: ${tool}` : `MCP ${s.mcpServer}`;
  }
  if (s.skill) return `Skill ${s.skill}`;
  if (s.tool && s.filePath) return `${s.tool} ${s.filePath}`;
  if (s.tool) return s.tool;
  if (s.filePath) return s.filePath;
  return s.attachment ?? "";
}

export interface BarSegment {
  /** Percent of the input, from its start. */
  left: number;
  width: number;
  category: ContextBlock["category"];
  blocks: ContextBlock[];
}

/** Below this share of the input a block has no room of its own: runs of them in one category merge. */
const TINY = 0.003;

/** The context bar's segments: a block each, or a run of tiny blocks of one category; blocks of 0 tokens skip. */
export function barSegments(blocks: readonly ContextBlock[], total: number): BarSegment[] {
  const out: BarSegment[] = [];
  const sum = Math.max(1, total);
  let offset = 0;
  let open: BarSegment | undefined;
  for (const b of blocks) {
    const t = b.tokens ?? 0;
    if (t <= 0) continue;
    const share = t / sum;
    const left = (100 * offset) / sum;
    offset += t;
    if (share < TINY && open && open.category === b.category) {
      open.width += 100 * share;
      open.blocks.push(b);
      continue;
    }
    const seg: BarSegment = { left, width: 100 * share, category: b.category, blocks: [b] };
    out.push(seg);
    open = share < TINY ? seg : undefined;
  }
  return out;
}
