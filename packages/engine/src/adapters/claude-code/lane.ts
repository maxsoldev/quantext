/**
 * Split one Call's input over its Blocks, against the latest split Call of its lane. Blocks the Call keeps in place
 * keep their tokens and their open runs; only the changed part is classified, estimated and attributed, so a long
 * session costs time and memory in proportion to its new content.
 */
import type { Call, CallBlock, RequestSection, TokenBasis, Usage } from "@quantext/shared";
import type { FreshBlock, Share } from "../../core/attribute.ts";
import { attributeCall, cachedPrefixLength, reconcile } from "../../core/attribute.ts";
import { replaysThinking } from "../../providers/anthropic/content.ts";
import type { Changes } from "./changes.ts";
import type { BlockRef, Classifier, ShapeRefs } from "./classify.ts";
import { get, put } from "./records.ts";
import type { CallSpec, Lane, ParserState } from "./state.ts";
import { wireHash } from "./wire.ts";

export interface SplitContext {
  state: ParserState;
  classifier: Classifier;
  changes: Changes;
}

interface FreshEntry {
  ref: BlockRef;
  section: RequestSection;
  message: number;
  /** For a deferred tool schema placed after its tool reference: the tool. */
  deferredTool?: string;
}

export function laneOf(state: ParserState, key: string, sessionId: string): Lane {
  const id = `${sessionId}|${key}`;
  return (
    get(state.lanes, id) ??
    put(state.lanes, id, {
      key,
      sessionId,
      shapeCount: 0,
      messages: [],
      messageEnds: [],
      blocks: [],
      sections: [],
      messageOf: [],
      contentOf: [],
      tokens: [],
      basis: [],
      group: [],
      estimates: [],
      prefix: [0],
      lone: [0],
      runs: [],
      reasoning: [],
      groupCount: {},
      partial: {},
      deferred: [],
    })
  );
}

/** Split a Call with a complete request and a Usage; sets its tokens, framing, cache boundary and runs. */
export function splitCall(ctx: SplitContext, call: Call, spec: CallSpec, usage: Usage): void {
  const { state, classifier, changes } = ctx;
  const lane = laneOf(state, spec.lane, call.sessionId);
  const shape = spec.shapeHash === undefined ? undefined : classifier.shape(spec.shapeHash);
  if (shape === undefined) return;
  const messages = messagesOf(state, spec, lane);
  let shared = lane.shapeKey === shape.key ? commonPrefix(messages, lane.messages) : 0;
  shared = Math.min(shared, deferredLimit(lane, shape), thinkingLimit(state, lane, messages, call));
  const keptPos =
    lane.shapeKey !== shape.key ? 0 : shared === 0 ? shape.refs.length : (lane.messageEnds[shared - 1] ?? 0);

  const fresh = freshEntries(classifier, shape, messages, keptPos === 0 ? 0 : shared, keptPos === 0);
  applyOutputAnchor(state, lane, messages, fresh, call);
  const pool = droppedPool(lane, keptPos);
  const breakpoints = spec.breakpoints.flatMap((path) => positionOf(path, lane, shape, shared, keptPos, fresh));
  const { keptExact, partialAfter } = keptExactness(lane, keptPos);
  const result = attributeCall({
    id: call.id,
    usage,
    kept: {
      count: keptPos,
      tokens: lane.prefix[keptPos] ?? 0,
      exact: keptExact,
      estimates: () => lane.estimates.slice(0, keptPos),
    },
    fresh: fresh.map((f): FreshBlock => {
      const carried = pool.get(f.ref.hash)?.shift();
      return carried === undefined ? { estimate: f.ref.estimate } : { estimate: f.ref.estimate, carried };
    }),
    ...(breakpoints.length > 0 ? { lastBreakpoint: Math.max(...breakpoints) } : {}),
    groupSize: (g) => get(state.groupSizes, g) ?? 0,
  });
  for (const g of result.groups) put(state.groupSizes, g.id, g.size);

  // A Call that is not split has no blocks (no blockCount), so runs may go on across it; only a new split restarts.
  const restart = result.kept !== undefined;
  truncate(lane, keptPos, changes);
  lane.partial = partialAfter;
  if (restart) {
    for (let p = 0; p < keptPos; p++) closeRun(lane, p, changes);
    if (result.kept !== undefined) replaceKept(lane, result.kept);
    for (let p = 0; p < keptPos; p++) openRun(lane, p, call, changes);
  }
  lane.messages.length = Math.min(lane.messages.length, keptPos === 0 ? 0 : shared);
  lane.messageEnds.length = lane.messages.length;
  if (keptPos === 0) lane.deferred = [];
  lane.shapeKey = shape.key;
  lane.shapeCount = shape.refs.length;
  appendFresh(lane, fresh, result.fresh, messages, call, changes);
  lane.lastIndex = call.index;
  lane.lastCallId = call.id;
  call.blockCount = lane.blocks.length;
  call.cacheBreakpoints = breakpoints;
  call.framingTokens = result.framingTokens;
  call.issues.push(...result.issues);
  const read = usage.cacheReadTokens;
  call.cacheBoundary = {
    tokens: read,
    position: cachedPrefixLength((i) => lane.prefix[i] ?? 0, lane.blocks.length, read),
  };
  linkResults(state, fresh, changes);
}

/** The message hashes of a request: the base's first `keep` messages, then the tail. */
function messagesOf(state: ParserState, spec: CallSpec, lane: Lane): string[] {
  // Walk the base chain back to a Call whose messages are known: the lane's latest Call, or one with no base.
  const chain: CallSpec[] = [];
  let start: readonly string[] = [];
  for (let at: CallSpec | undefined = spec; at !== undefined; ) {
    chain.push(at);
    if (at.baseId === undefined) break;
    if (at.baseId === lane.lastCallId) {
      start = lane.messages;
      break;
    }
    at = get(state.specs, at.baseId);
  }
  let list: readonly string[] = start;
  for (let i = chain.length - 1; i >= 0; i--) {
    const s = chain[i] as CallSpec;
    list = [...list.slice(0, s.baseId === undefined ? 0 : s.keep), ...s.tail];
  }
  return [...list];
}

function commonPrefix(a: readonly string[], b: readonly string[]): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

/** Kept messages must not hold a deferred tool schema that this Call's shape gives differently. */
function deferredLimit(lane: Lane, shape: ShapeRefs): number {
  let limit = Number.POSITIVE_INFINITY;
  for (const d of lane.deferred) {
    if (get(shape.deferred, d.tool)?.hash === d.hash) continue;
    const message = lane.messageOf[d.position] ?? 0;
    limit = Math.min(limit, message);
  }
  return limit;
}

/**
 * A model that drops the thinking of earlier turns sends the last assistant message differently once a newer
 * assistant message follows it: from that message on, nothing is kept unchanged.
 */
function thinkingLimit(state: ParserState, lane: Lane, messages: readonly string[], call: Call): number {
  if (replaysThinking(call.canonicalModel)) return Number.POSITIVE_INFINITY;
  const role = (hash: string | undefined) => get(state.messages, hash ?? "")?.role;
  for (let m = lane.messages.length - 1; m >= 0; m--) {
    if (role(lane.messages[m]) !== "assistant") continue;
    const start = m === 0 ? lane.shapeCount : (lane.messageEnds[m - 1] ?? 0);
    if (!lane.reasoning.slice(start, lane.messageEnds[m] ?? 0).some(Boolean)) return Number.POSITIVE_INFINITY;
    for (let k = m + 1; k < messages.length; k++) if (role(messages[k]) === "assistant") return m;
    return Number.POSITIVE_INFINITY;
  }
  return Number.POSITIVE_INFINITY;
}

/** The Blocks after the kept part: shape Blocks when nothing is kept, then the new messages. */
function freshEntries(
  classifier: Classifier,
  shape: ShapeRefs,
  messages: readonly string[],
  from: number,
  withShape: boolean,
) {
  const out: FreshEntry[] = [];
  if (withShape) {
    for (const [i, ref] of shape.refs.entries()) out.push({ ref, section: shape.sections[i] ?? "system", message: -1 });
  }
  for (let m = from; m < messages.length; m++) {
    for (const ref of classifier.message(messages[m] ?? "") ?? []) {
      out.push({ ref, section: "messages", message: m });
      for (const tool of ref.references) {
        const schema = get(shape.deferred, tool);
        if (schema !== undefined) out.push({ ref: schema, section: "messages", message: m, deferredTool: tool });
      }
    }
  }
  return out;
}

/**
 * The previous Call's response comes back as the assistant message of the next tail. Its output tokens are a far
 * better weight than its characters: thinking gets the reasoning tokens (none if the model drops it), the other
 * Blocks the rest, split by characters. The split stays an estimate, reconciled to the exact change.
 */
function applyOutputAnchor(
  state: ParserState,
  lane: Lane,
  messages: readonly string[],
  fresh: FreshEntry[],
  call: Call,
): void {
  const response = lane.lastCallId === undefined ? undefined : get(state.responses, lane.lastCallId);
  const content = response === undefined ? undefined : get(state.assistant, response.messageId);
  if (response === undefined || content === undefined) return;
  const m = messages.indexOf(wireHash("assistant", content));
  const own = fresh.filter((f) => f.message === m && m >= 0 && f.deferredTool === undefined);
  if (own.length === 0) return;
  const thinking = own.filter((f) => f.ref.kind === "reasoning");
  const others = own.filter((f) => f.ref.kind !== "reasoning");
  const reasoning = replaysThinking(call.canonicalModel) ? (response.reasoningTokens ?? 0) : 0;
  const rest = Math.max(0, response.outputTokens - (response.reasoningTokens ?? 0));
  const weigh = (entries: FreshEntry[], total: number) =>
    reconcile(
      entries.map((f) => f.ref.estimate),
      total,
    ).forEach((tokens, i) => {
      const entry = entries[i];
      if (entry !== undefined) entry.ref = { ...entry.ref, estimate: { tokens, method: "chars" } };
    });
  weigh(thinking, reasoning);
  weigh(others, rest);
  // The other new Blocks of the Call (tool results) take what the response leaves.
  for (const f of fresh) {
    if (f.message !== m && f.message >= 0)
      f.ref = { ...f.ref, estimate: { tokens: f.ref.estimate.tokens, method: "rest" } };
  }
}

/** The tokens of the Blocks after the kept part, by content: the next Call may send them again elsewhere. */
function droppedPool(lane: Lane, keptPos: number): Map<string, Share[]> {
  const pool = new Map<string, Share[]>();
  for (let p = keptPos; p < lane.blocks.length; p++) {
    const hash = lane.blocks[p] ?? "";
    const g = lane.group[p];
    const share: Share = { tokens: lane.tokens[p] ?? 0, basis: lane.basis[p] ?? "estimate" };
    if (g !== null && g !== undefined) share.group = g;
    pool.set(hash, [...(pool.get(hash) ?? []), share]);
  }
  return pool;
}

/** The kept sum is exact when no group in it lost members and no Block in it is a lone estimate. */
function keptExactness(lane: Lane, keptPos: number) {
  const partialAfter: Record<string, 1> = {};
  for (const g of Object.keys(lane.partial)) put(partialAfter, g, 1);
  const lost = new Map<string, number>();
  for (let p = keptPos; p < lane.blocks.length; p++) {
    const g = lane.group[p];
    if (g !== null && g !== undefined) lost.set(g, (lost.get(g) ?? 0) + 1);
  }
  for (const [g, n] of lost) {
    const left = (get(lane.groupCount, g) ?? 0) - n;
    if (left > 0) put(partialAfter, g, 1);
    else delete partialAfter[g];
  }
  return { keptExact: Object.keys(partialAfter).length === 0 && (lane.lone[keptPos] ?? 0) === 0, partialAfter };
}

/** The position of a cache breakpoint path in this Call's input. */
function positionOf(
  path: readonly (string | number)[],
  lane: Lane,
  shape: ShapeRefs,
  shared: number,
  keptPos: number,
  fresh: readonly FreshEntry[],
): number[] {
  const [section, i, , j] = path;
  if (section === "system" && typeof i === "number") return [shape.toolCount + i];
  if (section === "tools" && typeof i === "number") {
    const p = shape.refs.findIndex((r, k) => shape.sections[k] === "tools" && r.contentIndex === i);
    return p < 0 ? [] : [p];
  }
  if (section !== "messages" || typeof i !== "number" || typeof j !== "number") return [];
  if (keptPos > 0 && i < shared) {
    const start = i === 0 ? lane.shapeCount : (lane.messageEnds[i - 1] ?? 0);
    for (let p = start; p < (lane.messageEnds[i] ?? 0); p++) if (lane.contentOf[p] === j) return [p];
    return [];
  }
  const k = fresh.findIndex((f) => f.message === i && f.deferredTool === undefined && f.ref.contentIndex === j);
  return k < 0 ? [] : [keptPos + k];
}

function truncate(lane: Lane, keptPos: number, changes: Changes): void {
  for (let p = lane.blocks.length - 1; p >= keptPos; p--) {
    closeRun(lane, p, changes);
    const g = lane.group[p];
    if (g !== null && g !== undefined) {
      const left = (get(lane.groupCount, g) ?? 1) - 1;
      if (left > 0) put(lane.groupCount, g, left);
      else delete lane.groupCount[g];
    }
  }
  const lists = [lane.blocks, lane.sections, lane.messageOf, lane.contentOf, lane.tokens, lane.basis, lane.group];
  for (const list of [...lists, lane.estimates, lane.runs, lane.reasoning])
    list.length = Math.min(list.length, keptPos);
  lane.prefix.length = keptPos + 1;
  lane.lone.length = keptPos + 1;
  lane.deferred = lane.deferred.filter((d) => d.position < keptPos);
}

function replaceKept(lane: Lane, shares: readonly Share[]): void {
  lane.groupCount = {};
  lane.partial = {};
  for (const [p, share] of shares.entries()) setShare(lane, p, share);
}

function setShare(lane: Lane, p: number, share: Share): void {
  lane.tokens[p] = share.tokens;
  lane.basis[p] = share.basis;
  lane.group[p] = share.group ?? null;
  if (share.group !== undefined) put(lane.groupCount, share.group, (get(lane.groupCount, share.group) ?? 0) + 1);
  lane.prefix[p + 1] = (lane.prefix[p] ?? 0) + share.tokens;
  lane.lone[p + 1] = (lane.lone[p] ?? 0) + (share.basis === "estimate" && share.group === undefined ? 1 : 0);
}

function appendFresh(
  lane: Lane,
  fresh: readonly FreshEntry[],
  shares: readonly Share[],
  messages: readonly string[],
  call: Call,
  changes: Changes,
): void {
  fresh.forEach((entry, k) => {
    const p = lane.blocks.length;
    lane.blocks.push(entry.ref.hash);
    lane.sections.push(entry.section);
    lane.messageOf.push(entry.message);
    lane.contentOf.push(entry.deferredTool === undefined ? entry.ref.contentIndex : -1);
    lane.estimates.push(entry.ref.estimate);
    lane.reasoning.push(entry.ref.kind === "reasoning");
    setShare(lane, p, shares[k] ?? { tokens: 0, basis: "estimate" });
    if (entry.deferredTool !== undefined)
      lane.deferred.push({ position: p, tool: entry.deferredTool, hash: entry.ref.hash });
    openRun(lane, p, call, changes);
    if (entry.section === "messages") lane.messageEnds[entry.message] = p + 1;
  });
  for (let m = lane.messages.length; m < messages.length; m++) {
    lane.messages.push(messages[m] ?? "");
    lane.messageEnds[m] ??= m === 0 ? lane.shapeCount : (lane.messageEnds[m - 1] ?? lane.shapeCount);
  }
}

function openRun(lane: Lane, p: number, call: Call, changes: Changes): void {
  const run: CallBlock = {
    id: `${lane.sessionId}:${lane.key}:${call.index}:${p}`,
    sessionId: lane.sessionId,
    lane: lane.key,
    blockHash: lane.blocks[p] ?? "",
    position: p,
    section: lane.sections[p] ?? "messages",
    tokens: lane.tokens[p] ?? 0,
    basis: lane.basis[p] ?? ("estimate" as TokenBasis),
    firstCall: call.index,
  };
  const message = lane.messageOf[p] ?? -1;
  if (message >= 0) run.message = message;
  const group = lane.group[p];
  if (group !== null && group !== undefined) run.group = group;
  lane.runs[p] = run;
  changes.run(run);
}

function closeRun(lane: Lane, p: number, changes: Changes): void {
  const run = lane.runs[p];
  if (run === undefined || run.lastCall !== undefined || lane.lastIndex === undefined) return;
  run.lastCall = lane.lastIndex;
  changes.run(run);
}

/** A tool result sent for the first time is the result Block of its ToolCall. */
function linkResults(state: ParserState, fresh: readonly FreshEntry[], changes: Changes): void {
  for (const { ref } of fresh) {
    if (ref.toolUseId === undefined) continue;
    const toolCall = get(state.toolCalls, ref.toolUseId);
    if (toolCall === undefined || toolCall.resultBlockHash !== undefined) continue;
    toolCall.resultBlockHash = ref.hash;
    changes.toolCalls.add(toolCall.id);
  }
}
