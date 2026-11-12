/** Shaping a Call's context for the viewer: the rows of its block list, its hidden part, a Block's source in words. */
import type { BlockSource, CallContext, ContextBlock, RequestSection } from "@quantext/shared";

export type Row =
  | { type: "section"; section: RequestSection; tokens: number; blocks: number }
  | { type: "block"; block: ContextBlock };

const ORDER: readonly RequestSection[] = ["tools", "system", "messages"];

/** The sections in request order, each with a header row; the framing tokens go last, with the messages. */
export function listRows(ctx: CallContext): Row[] {
  const rows: Row[] = [];
  for (const section of ORDER) {
    const blocks = ctx.blocks.filter((b) => b.section === section);
    if (blocks.length === 0) continue;
    rows.push({ type: "section", section, tokens: ctx.sections[section], blocks: blocks.length });
    for (const block of blocks) rows.push({ type: "block", block });
  }
  for (const block of ctx.blocks.filter((b) => b.section === "framing")) rows.push({ type: "block", block });
  return rows;
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
