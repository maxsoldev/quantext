/** Shaping a Call's context for the viewer: the rows of its block list, its hidden part, a Block's source in words. */
import type { BlockSource, CallContext, ContextBlock, ContextPart, RequestSection } from "@quantext/shared";
import { KIND_LABEL } from "./kinds.ts";

export type Row =
  | { type: "section"; section: RequestSection; tokens: number; blocks: number }
  | { type: "block"; block: ContextBlock }
  | { type: "part"; block: ContextBlock; part: ContextPart };

const ORDER: readonly RequestSection[] = ["tools", "system", "messages"];

/**
 * The sections in request order, each with a header row, then its blocks, each followed by its parts when it has
 * more than one; the framing tokens go last, with the messages. `find` keeps the blocks whose kind, source,
 * preview or part matches (case does not count), with only the parts that match when any does.
 */
export function listRows(ctx: CallContext, find = ""): Row[] {
  const needle = find.trim().toLowerCase();
  const has = (...texts: string[]) => texts.some((t) => t.toLowerCase().includes(needle));
  const blockRows = (block: ContextBlock): Row[] => {
    const parts = (block.parts?.length ?? 0) > 1 ? (block.parts ?? []) : [];
    const own = has(KIND_LABEL[block.kind], blockSource(block), block.preview);
    const hits = needle === "" ? parts : parts.filter((p) => has(p.label, p.preview));
    if (needle !== "" && !own && hits.length === 0) return [];
    const shown = hits.length > 0 ? hits : parts;
    return [{ type: "block", block }, ...shown.map((part): Row => ({ type: "part", block, part }))];
  };
  const rows: Row[] = [];
  for (const section of ORDER) {
    const blocks = ctx.blocks.filter((b) => b.section === section);
    const shown = blocks.flatMap(blockRows);
    if (shown.length === 0) continue;
    rows.push({ type: "section", section, tokens: ctx.sections[section], blocks: blocks.length }, ...shown);
  }
  for (const block of ctx.blocks.filter((b) => b.section === "framing")) rows.push(...blockRows(block));
  return rows;
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
