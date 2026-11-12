/**
 * Which parts of the block list are open: each section by its kind, the parts of each block by its hash, and the
 * categories of the token-share table that show their parts. Pure; the view keeps it in localStorage, so it holds
 * across calls and reloads.
 */
import type { CallContext, ContextBlock, ContextCategory } from "@quantext/shared";

/** The folding sections of the block list, in order; framing stays a row of its own. */
export type Fold = "tools" | "system" | "messages" | "output";
export const FOLDS: readonly Fold[] = ["tools", "system", "messages", "output"];

export interface Collapse {
  open: Readonly<Record<Fold, boolean>>;
  /** Hashes of the blocks whose parts are shown. */
  blocks: readonly string[];
  /** Categories whose part totals are shown in the token-share table. */
  cats: readonly ContextCategory[];
}

/** The hidden part closed, the conversation and the answer open, no parts shown. */
export const DEFAULT_COLLAPSE: Collapse = {
  open: { tools: false, system: false, messages: true, output: true },
  blocks: [],
  cats: [],
};

/** At most this many block hashes are kept: the latest opened. */
const MAX_BLOCKS = 100;

const withParts = (b: ContextBlock): b is ContextBlock & { hash: string } =>
  b.hash !== undefined && (b.parts?.length ?? 0) > 1;
const foldOf = (b: ContextBlock): Fold => (b.section === "framing" ? "messages" : b.section);
const add = <T>(xs: readonly T[], x: T): T[] => [...xs.filter((y) => y !== x), x];

export function toggleSection(s: Collapse, fold: Fold): Collapse {
  return { ...s, open: { ...s.open, [fold]: !s.open[fold] } };
}

/** Shows or hides a block's parts; showing them also shows its category's part totals. */
export function toggleBlock(s: Collapse, b: ContextBlock): Collapse {
  if (b.hash === undefined) return s;
  if (s.blocks.includes(b.hash)) return { ...s, blocks: s.blocks.filter((h) => h !== b.hash) };
  return { ...s, blocks: add(s.blocks, b.hash).slice(-MAX_BLOCKS), cats: add(s.cats, b.category) };
}

/** Every section open, and the parts of every block of `ctx` and of every category. */
export function expandAll(s: Collapse, ctx: CallContext): Collapse {
  let out: Collapse = { ...s, open: { tools: true, system: true, messages: true, output: true } };
  for (const b of ctx.blocks.filter(withParts)) if (!out.blocks.includes(b.hash)) out = toggleBlock(out, b);
  return { ...out, cats: [...new Set([...out.cats, ...ctx.partTotals.map((p) => p.category)])] };
}

/** Every section closed, no parts shown. */
export function collapseAll(): Collapse {
  return { open: { tools: false, system: false, messages: false, output: false }, blocks: [], cats: [] };
}

/** Opens what a link to a block needs: its section. */
export function revealBlock(s: Collapse, b: ContextBlock): Collapse {
  return { ...s, open: { ...s.open, [foldOf(b)]: true } };
}

/**
 * Shows or hides a category's part totals, with the parts of its blocks in the list; showing opens the sections
 * of the blocks of that category that hold parts.
 */
export function toggleCategory(s: Collapse, ctx: CallContext, cat: ContextCategory): Collapse {
  const blocks = ctx.blocks.filter((b) => b.category === cat && (b.parts?.length ?? 0) > 0);
  const many = blocks.filter(withParts).map((b) => b.hash);
  if (s.cats.includes(cat)) {
    return { ...s, cats: s.cats.filter((c) => c !== cat), blocks: s.blocks.filter((h) => !many.includes(h)) };
  }
  const open = { ...s.open };
  for (const b of blocks) open[foldOf(b)] = true;
  const shown = [...s.blocks.filter((h) => !many.includes(h)), ...many].slice(-MAX_BLOCKS);
  return { open, blocks: shown, cats: add(s.cats, cat) };
}

/** A stored state, or the defaults for anything missing or not readable. */
export function readCollapse(raw: string | null): Collapse {
  if (raw === null) return DEFAULT_COLLAPSE;
  try {
    const v = JSON.parse(raw) as Partial<Collapse>;
    const open = { ...DEFAULT_COLLAPSE.open };
    for (const f of FOLDS) if (typeof v.open?.[f] === "boolean") open[f] = v.open[f];
    const strings = <T extends string>(xs: unknown): T[] =>
      Array.isArray(xs) ? (xs.filter((x) => typeof x === "string") as T[]) : [];
    return { open, blocks: strings<string>(v.blocks).slice(-MAX_BLOCKS), cats: strings<ContextCategory>(v.cats) };
  } catch (e) {
    console.warn("quantext: the stored open sections are not readable, using the defaults", e);
    return DEFAULT_COLLAPSE;
  }
}
