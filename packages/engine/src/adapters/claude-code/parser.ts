/**
 * The incremental Claude Code parser: feed it transcript text as it grows, get back what changed. Rows are handled
 * one at a time, in order, so the result does not depend on how the text was cut into pieces.
 */
import type {
  Call,
  CallIssue,
  Compaction,
  ContentLookup,
  IngestReport,
  Session,
  SessionDelta,
  ToolCall,
  Usage,
} from "@quantext/shared";
import type { Estimator } from "../../core/estimate.ts";
import { estimateBlock } from "../../providers/anthropic/estimate.ts";
import { canonicalModel } from "../../providers/anthropic/pricing.ts";
import { Changes } from "./changes.ts";
import type { Classifier } from "./classify.ts";
import { createClassifier, textHash, toolSource } from "./classify.ts";
import type { JsonObject } from "./json.ts";
import { arr, num, obj, str } from "./json.ts";
import { laneOf, splitCall } from "./lane.ts";
import { Content, NO_LOOKUP } from "./lookup.ts";
import { paramsOf, sameUsage, setUsage, usageOf } from "./mapping.ts";
import { get, put } from "./records.ts";
import type { Row } from "./rows.ts";
import { countUnknown, readLine } from "./rows.ts";
import type { CallSpec, Lane, ParserState, TranscriptState, UsageSum } from "./state.ts";
import { emptyState } from "./state.ts";
import { addAssistantRow, addBlob, addUserRow, blocksOf, resolve } from "./wire.ts";

export interface ParseOptions {
  /** Splits a total over several new Blocks; the default estimates Anthropic content by characters and image size. */
  estimator?: Estimator;
  /**
   * What the caller kept from earlier deltas (records, blocks, calls, runs). Needed when the parser is restored
   * from a snapshot: the snapshot holds only the open frontier, not the content of the session so far.
   */
  lookup?: ContentLookup;
}

export interface ClaudeCodeParser {
  /**
   * Read more text of a transcript: `main`, or a name for a subagent transcript. A last line without a newline is
   * held back until more text (or `flush`) completes it.
   */
  push(text: string, transcript?: string): SessionDelta;
  /** Read a subagent's meta file (`agent-<id>.meta.json`), which links it to the tool call that started it. */
  pushMeta(transcript: string, text: string): SessionDelta;
  /** Read the held-back last line of a transcript as complete (the file ended without a newline). */
  flush(transcript?: string): SessionDelta;
  /** The state, as plain JSON: give it to `createClaudeCodeParser` to go on from here. */
  snapshot(): ParserState;
}

export const HARNESS = "claude-code";

/** Rows that can bring a missing part of a waiting request. */
const WIRE_ROWS = new Set(["api-request-blob", "api-request-shape", "api-request", "user", "assistant"]);
/** Calls kept waiting for a missing part; older ones stay unresolved. */
const MAX_WAITING = 32;

export function createClaudeCodeParser(
  state: ParserState = emptyState(),
  options: ParseOptions = {},
): ClaudeCodeParser {
  const estimator = options.estimator ?? estimateBlock;
  let changes = new Changes();
  const store = new Content(state, options.lookup ?? NO_LOOKUP, (record) => changes.records.set(record.key, record));
  const classifier: Classifier = createClassifier(
    store,
    (block, unknownType) => {
      changes.blocks.push(block);
      if (unknownType !== undefined) countUnknown(changes.report, `content block ${unknownType}`);
    },
    estimator,
  );
  const read = (work: () => void): SessionDelta => {
    changes = new Changes();
    work();
    mergeReport(state.report, changes.report);
    return changes.delta(state);
  };
  const handler = (name: string) => new Rows(store, classifier, () => changes, name, estimator);
  return {
    push: (text, transcript = "main") =>
      read(() => {
        const t = transcriptOf(state, transcript);
        const lines = (t.buffer + text).split("\n");
        t.buffer = lines.pop() ?? "";
        const rows = handler(transcript);
        for (const line of lines) rows.line(line);
      }),
    pushMeta: (transcript, text) => read(() => handler(transcript).meta(text)),
    flush: (transcript = "main") =>
      read(() => {
        const t = transcriptOf(state, transcript);
        const line = t.buffer;
        t.buffer = "";
        if (line !== "") handler(transcript).line(line);
      }),
    snapshot: () => frontier(state),
  };
}

function transcriptOf(state: ParserState, name: string): TranscriptState {
  return (
    get(state.transcripts, name) ??
    put(state.transcripts, name, { buffer: "", lines: 0, userRun: [], usageSinceCost: {} })
  );
}

function mergeReport(total: IngestReport, delta: IngestReport): void {
  total.unreadable.push(...delta.unreadable);
  for (const { kind, count } of delta.unknownRecords) {
    const entry = total.unknownRecords.find((e) => e.kind === kind);
    if (entry === undefined) total.unknownRecords.push({ kind, count });
    else entry.count += count;
  }
}

/** The handlers of the rows of one transcript. */
class Rows {
  private readonly t: TranscriptState;
  private readonly store: Content;
  private readonly state: ParserState;
  private readonly classifier: Classifier;
  private readonly changes: () => Changes;
  private readonly name: string;
  private readonly estimator: Estimator;

  constructor(store: Content, classifier: Classifier, changes: () => Changes, name: string, estimator: Estimator) {
    this.store = store;
    this.state = store.state;
    this.classifier = classifier;
    this.changes = changes;
    this.name = name;
    this.estimator = estimator;
    this.t = transcriptOf(store.state, name);
  }

  line(text: string): void {
    this.t.lines++;
    const row = readLine(`${this.name}:${this.t.lines}`, text, this.changes().report);
    if (row !== undefined) this.row(row);
  }

  meta(text: string): void {
    let toolUseId: string | undefined;
    try {
      toolUseId = str(obj(JSON.parse(text))?.toolUseId);
    } catch (error) {
      this.changes().report.unreadable.push({
        at: `${this.name}.meta`,
        reason: `not JSON: ${(error as Error).message}`,
      });
    }
    if (toolUseId === undefined) return;
    put(this.state.metaToolUse, this.name, toolUseId);
    this.linkChildren();
  }

  private row(row: Row): void {
    this.handle(row);
    if (Object.keys(this.state.waiting).length > 0 && WIRE_ROWS.has(row.type)) this.recheck();
  }

  /** Remember a call whose request is not complete yet: a later row may still bring the missing part. */
  private wait(id: string): void {
    put(this.state.waiting, id, this.name);
    const ids = Object.keys(this.state.waiting);
    if (ids.length > MAX_WAITING) delete this.state.waiting[ids[0] ?? ""];
  }

  /** Check the waiting calls again, oldest first; a call whose request is now complete waits for, or gets, its split. */
  private recheck(): void {
    const ids = Object.keys(this.state.waiting)
      .flatMap((id) => this.store.call(id) ?? [])
      .sort((a, b) => a.index - b.index);
    for (const call of ids) {
      const spec = this.store.spec(call.id);
      const transcript = get(this.state.waiting, call.id) ?? this.name;
      if (spec === undefined || this.missing(spec, transcriptOf(this.state, transcript)).length > 0) continue;
      delete this.state.waiting[call.id];
      call.issues = call.issues.filter((i) => i.kind !== "unresolved-request");
      this.changes().calls.add(call.id);
      if (call.usage === undefined) {
        call.issues.push({ kind: "no-usage", detail: "the log has no response with usage for this call yet" });
        put(this.state.pending, call.id, 1);
      } else {
        this.split(call, spec, call.usage);
      }
    }
  }

  private split(call: Call, spec: CallSpec, usage: Usage): void {
    const lane = laneOf(this.state, spec.lane, call.sessionId);
    if (lane.lastIndex !== undefined && lane.lastIndex > call.index) {
      call.issues.push({
        kind: "unreconciled-tokens",
        detail: "the response came after a later call was split; not split",
      });
      return;
    }
    const ctx = { store: this.store, classifier: this.classifier, changes: this.changes(), estimator: this.estimator };
    splitCall(ctx, call, spec, usage);
  }

  private handle(row: Row): void {
    const session = this.session(row);
    const data = row.data;
    const message = obj(data.message);
    switch (row.type) {
      case "api-request-blob":
        addBlob(this.store, data);
        break;
      case "api-request-shape": {
        const hash = str(data.shapeHash);
        const shape = obj(data.shape);
        if (hash !== undefined && shape !== undefined) {
          this.store.putShape(hash, { system: arr(shape.system) ?? [], tools: arr(shape.tools) ?? [] });
        }
        break;
      }
      case "api-request":
        if (session !== undefined) this.request(row, session);
        break;
      case "assistant":
        if (message !== undefined) this.assistant(row, message, session);
        break;
      case "user":
        if (message !== undefined) this.user(row, message, session);
        break;
      case "system/compact_boundary":
        if (session !== undefined) this.compaction(row, session);
        break;
      case "cost-state":
        this.costState(data);
        break;
      default:
        break; // known rows that hold nothing for the domain (UI and process state)
    }
  }

  /** The Session of the row's transcript, created or updated with what the row tells. */
  private session(row: Row): Session | undefined {
    const parent = str(row.data.sessionId);
    if (parent === undefined) return undefined;
    const agent = str(row.data.agentId) ?? get(this.state.transcriptAgent, this.name);
    const isAgent = this.name !== "main" && agent !== undefined;
    if (isAgent && get(this.state.transcriptAgent, this.name) === undefined) {
      put(this.state.transcriptAgent, this.name, agent);
      this.linkChildren();
    }
    const id = isAgent ? `${parent}:agent-${agent}` : parent;
    const existing = get(this.state.sessions, id);
    const session = existing ?? put(this.state.sessions, id, { id, harness: HARNESS });
    const before = JSON.stringify(session);
    if (isAgent) session.parentId = parent;
    const version = str(row.data.version);
    const cwd = str(row.data.cwd);
    if (version !== undefined) session.harnessVersion ??= version;
    if (cwd !== undefined && session.cwd === undefined) Object.assign(session, { project: cwd, cwd });
    const ts = str(row.data.timestamp);
    if (ts !== undefined) {
      if (session.started === undefined || ts < session.started) session.started = ts;
      if (session.ended === undefined || ts > session.ended) session.ended = ts;
    }
    if (existing === undefined || JSON.stringify(session) !== before) this.changes().sessions.add(id);
    return session;
  }

  private request(row: Row, session: Session): void {
    const data = row.data;
    const id = str(data.id) ?? row.at;
    const params = obj(data.params) ?? {};
    const model = str(params.model) ?? "";
    const lane = `${model}|${str(data.querySource) ?? ""}`;
    const tail = (arr(data.tail) ?? []).filter((h): h is string => typeof h === "string");
    const keep = num(data.keep) ?? 0;
    const spec: CallSpec = { sessionId: session.id, keep, tail, length: keep + tail.length, breakpoints: [], lane };
    const baseId = str(data.base);
    const shapeHash = str(data.shapeHash);
    if (baseId !== undefined) spec.baseId = baseId;
    if (shapeHash !== undefined) spec.shapeHash = shapeHash;
    spec.breakpoints = (arr(data.cacheControl) ?? []).flatMap((entry) => {
      const path = arr(obj(entry)?.path);
      return path === undefined
        ? []
        : [path.filter((p): p is string | number => typeof p === "string" || typeof p === "number")];
    });
    this.store.putSpec(id, spec);

    const call = this.newCall(session.id, id, str(data.timestamp) ?? "", model, lane);
    call.params = paramsOf(params);
    if (shapeHash !== undefined) call.shapeHash = shapeHash;
    const missing = this.missing(spec);
    call.issues.push(...missing.map((detail): CallIssue => ({ kind: "unresolved-request", detail })));
    if (missing.length === 0) {
      call.issues.push({ kind: "no-usage", detail: "the log has no response with usage for this call yet" });
      put(this.state.pending, id, 1);
    } else {
      this.wait(id);
    }
    this.t.lastCallId = id;
  }

  private newCall(sessionId: string, id: string, ts: string, model: string, lane: string): Call {
    const index = get(this.state.nextIndex, sessionId) ?? 0;
    put(this.state.nextIndex, sessionId, index + 1);
    const call: Call = {
      id,
      sessionId,
      index,
      ts,
      model,
      lane,
      params: {},
      cacheBreakpoints: [],
      framingTokens: 0,
      issues: [],
    };
    const canonical = canonicalModel(model);
    if (canonical !== undefined) call.canonicalModel = canonical;
    this.changes().calls.add(id);
    return put(this.state.calls, id, call);
  }

  /** What of a request is not in the log: its base, its shape, the messages of its tail. */
  private missing(spec: CallSpec, transcript: TranscriptState = this.t): string[] {
    const missing: string[] = [];
    const base = spec.baseId === undefined ? undefined : this.store.spec(spec.baseId);
    if (spec.baseId !== undefined && base === undefined) missing.push(`base call ${spec.baseId} is not in the log`);
    if (spec.keep > (base?.length ?? 0)) missing.push(`keep ${spec.keep} is more than the base call's messages`);
    if (
      spec.baseId !== undefined &&
      (this.store.call(spec.baseId)?.issues ?? []).some((i) => i.kind === "unresolved-request")
    ) {
      missing.push(`base call ${spec.baseId} is incomplete`);
    }
    if (spec.shapeHash === undefined || this.store.shape(spec.shapeHash) === undefined) {
      missing.push(`shape ${spec.shapeHash ?? "(none)"} is not in the log`);
    }
    for (const hash of spec.tail) {
      if (resolve(this.store, transcript, hash) === undefined) missing.push(`message ${hash} is not in the log`);
    }
    return missing;
  }

  private assistant(row: Row, message: JsonObject, session: Session | undefined): void {
    const messageHash = addAssistantRow(this.store, this.t, message);
    const messageId = str(message.id) ?? "";
    const requestRef = str(row.data.requestRef);
    if (session !== undefined) this.toolUses(row, message, messageId, requestRef ?? "", session.id);
    const raw = obj(message.usage);
    const call = requestRef === undefined ? undefined : this.store.call(requestRef);
    if (call === undefined || raw === undefined) return;
    const usage = usageOf(raw);
    const known = get(this.state.responses, call.id);
    if (known?.messageId === messageId && messageHash !== undefined) known.hash = messageHash;
    if (call.usage !== undefined) {
      if (!sameUsage(call.usage, usage)) this.usageChanged(call, usage, raw);
      return;
    }
    setUsage(call, usage, raw);
    addUsage(this.t.usageSinceCost, call, usage);
    if (this.t.openCompaction !== undefined) addUsage(this.t.openCompaction.logged, call, usage);
    const response: ParserState["responses"][string] = { messageId, outputTokens: usage.outputTokens };
    if (messageHash !== undefined) response.hash = messageHash;
    if (usage.reasoningOutputTokens !== undefined) response.reasoningTokens = usage.reasoningOutputTokens;
    put(this.state.responses, call.id, response);
    const pending = get(this.state.pending, call.id);
    const spec = this.store.spec(call.id);
    if (pending !== undefined && spec !== undefined) {
      delete this.state.pending[call.id];
      this.split(call, spec, usage);
    }
    this.changes().calls.add(call.id);
  }

  /** A later row of the same response with other usage: keep the newest counts, flag that the split used older ones. */
  private usageChanged(call: Call, usage: Usage, raw: JsonObject): void {
    setUsage(call, usage, raw);
    if (call.blockCount !== undefined) {
      call.issues.push({ kind: "unreconciled-tokens", detail: "usage changed after the call was split" });
    }
    this.changes().calls.add(call.id);
  }

  private toolUses(row: Row, message: JsonObject, messageId: string, callId: string, sessionId: string): void {
    for (const raw of arr(message.content) ?? []) {
      const block = obj(raw);
      if (block?.type !== "tool_use") continue;
      const id = str(block.id) ?? "";
      if (this.store.toolCall(id) !== undefined) continue;
      const name = str(block.name) ?? "";
      const input = block.input ?? null;
      const ids = [...(get(this.state.messageToolUses, messageId) ?? []), id];
      put(this.state.messageToolUses, messageId, ids);
      const ts = str(row.data.timestamp);
      if (ts !== undefined) put(this.state.toolUseTimes, id, ts);
      const toolCall: ToolCall = {
        id,
        sessionId,
        callId,
        name,
        input,
        source: toolSource(name, obj(input)),
        isError: false,
        parallel: 1,
      };
      put(this.state.toolCalls, id, toolCall);
      for (const sibling of ids) {
        const t = this.store.toolCall(sibling);
        if (t === undefined) continue;
        t.parallel = ids.length;
        this.changes().toolCalls.add(sibling);
      }
      this.linkChildren();
    }
  }

  private user(row: Row, message: JsonObject, session: Session | undefined): void {
    addUserRow(this.store, this.t, message);
    const data = row.data;
    const texts = blocksOf(message.content).flatMap((b) => str(obj(b)?.text) ?? []);
    if (data.isCompactSummary === true) for (const text of texts) put(this.state.summaries, textHash(text), 1);
    const source = this.store.toolCall(str(data.sourceToolUseID) ?? "");
    const skill = str(obj(source?.input)?.skill);
    if (data.isMeta === true && source?.name === "Skill" && skill !== undefined) {
      for (const text of texts) put(this.state.skills, textHash(text), skill);
    }
    const ts = str(data.timestamp);
    for (const raw of blocksOf(message.content)) {
      const block = obj(raw);
      const id = str(block?.tool_use_id);
      const toolCall = id === undefined || block?.type !== "tool_result" ? undefined : this.store.toolCall(id);
      if (toolCall === undefined || id === undefined) continue;
      toolCall.isError = block?.is_error === true;
      const started = get(this.state.toolUseTimes, id);
      const ms = started === undefined || ts === undefined ? Number.NaN : Date.parse(ts) - Date.parse(started);
      if (!Number.isNaN(ms)) toolCall.durationMs = ms;
      this.changes().toolCalls.add(id);
    }
    const agentId = str(obj(data.toolUseResult)?.agentId);
    const first = obj(blocksOf(message.content)[0]);
    const toolUseId = str(first?.tool_use_id);
    if (agentId !== undefined && toolUseId !== undefined && session !== undefined) {
      put(this.state.agentToolUse, agentId, toolUseId);
      this.link(toolUseId, `${session.id}:agent-${agentId}`);
    }
  }

  /** Link the tool calls that started subagents to their Sessions, from meta files and known agent ids. */
  private linkChildren(): void {
    for (const [transcript, toolUseId] of Object.entries(this.state.metaToolUse)) {
      const agent = get(this.state.transcriptAgent, transcript);
      const parent = this.store.toolCall(toolUseId)?.sessionId;
      if (agent !== undefined && parent !== undefined) this.link(toolUseId, `${parent}:agent-${agent}`);
    }
  }

  private link(toolUseId: string, childSessionId: string): void {
    const toolCall = this.store.toolCall(toolUseId);
    if (toolCall === undefined || toolCall.childSessionId === childSessionId) return;
    toolCall.childSessionId = childSessionId;
    this.changes().toolCalls.add(toolUseId);
  }

  private compaction(row: Row, session: Session): void {
    const data = row.data;
    const id = str(data.uuid) ?? row.at;
    const meta = obj(data.compactMetadata);
    const ts = str(data.timestamp) ?? "";
    const compaction: Compaction = { id, sessionId: session.id, ts, trigger: str(meta?.trigger) ?? "" };
    const before = num(meta?.preTokens);
    const after = num(meta?.postTokens);
    if (before !== undefined) compaction.beforeTokens = before;
    if (after !== undefined) compaction.afterTokens = after;
    if (this.t.lastCallId !== undefined) compaction.beforeCallId = this.t.lastCallId;
    const summary = this.newCall(session.id, `${id}:summary`, ts, "", "compaction");
    summary.issues.push({
      kind: "unresolved-request",
      detail: "the summarising request is not in the log, only its derived usage",
    });
    compaction.summaryCallId = summary.id;
    put(this.state.compactions, id, compaction);
    this.changes().compactions.add(id);
    const open: NonNullable<TranscriptState["openCompaction"]> = {
      summaryCallId: summary.id,
      logged: structuredClone(this.t.usageSinceCost),
    };
    if (this.t.costTotals !== undefined) open.before = this.t.costTotals;
    if (before !== undefined) open.preTokens = before;
    this.t.openCompaction = open;
  }

  /** A running total: the summarising Call of an open compaction gets the change, less the Calls logged since. */
  private costState(data: JsonObject): void {
    const totals = obj(data.modelUsage) ?? {};
    const open = this.t.openCompaction;
    if (open !== undefined && open.before !== undefined) {
      const call = this.store.call(open.summaryCallId);
      const derived = derivedUsage(open.before, totals, open.logged);
      if (call !== undefined && derived !== undefined) {
        call.model = derived.model;
        const canonical = canonicalModel(derived.model);
        if (canonical !== undefined) call.canonicalModel = canonical;
        setUsage(call, derived.usage);
        const input = derived.usage.inputTokens + derived.usage.cacheReadTokens + derived.usage.cacheWriteTokens;
        if (open.preTokens !== undefined && input < open.preTokens) {
          const detail = `derived input ${input} is less than the ${open.preTokens} tokens of context before the compaction`;
          call.issues.push({ kind: "unreconciled-tokens", detail });
        }
        this.changes().calls.add(call.id);
      }
    }
    delete this.t.openCompaction;
    this.t.costTotals = totals;
    this.t.usageSinceCost = {};
  }
}

const COUNTERS = {
  inputTokens: "inputTokens",
  cacheReadTokens: "cacheReadInputTokens",
  cacheWriteTokens: "cacheCreationInputTokens",
  cacheWrite5mTokens: "cacheCreationEphemeral5mInputTokens",
  cacheWrite1hTokens: "cacheCreationEphemeral1hInputTokens",
  outputTokens: "outputTokens",
} as const;

/** Add a Call's Usage to running sums per model, by the names of `cost-state`'s counters. */
function addUsage(sums: Record<string, UsageSum>, call: Call, usage: Usage): void {
  const model = call.canonicalModel ?? call.model;
  const sum = get(sums, model) ?? put(sums, model, {});
  for (const [field, key] of Object.entries(COUNTERS) as [keyof typeof COUNTERS, string][]) {
    sum[key] = (sum[key] ?? 0) + (usage[field] ?? 0);
  }
}

/**
 * The usage of a summarising Call: the change of the running totals of the one model whose totals changed more
 * than its logged Calls account for. A counter missing on either side stays unknown (a time-to-live split), not 0.
 */
function derivedUsage(before: JsonObject, after: JsonObject, logged: Record<string, UsageSum>) {
  const changed = Object.keys(after).flatMap((model) => {
    const a = obj(after[model]) ?? {};
    const b = obj(before[model]) ?? {};
    const sum = get(logged, canonicalModel(model) ?? model) ?? {};
    const usage: Usage = { basis: "derived", inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 };
    for (const [field, key] of Object.entries(COUNTERS) as [keyof typeof COUNTERS, string][]) {
      if (a[key] === undefined || b[key] === undefined) continue;
      usage[field] = (num(a[key]) ?? 0) - (num(b[key]) ?? 0) - (sum[key] ?? 0);
    }
    const any = (Object.keys(COUNTERS) as (keyof typeof COUNTERS)[]).some((field) => (usage[field] ?? 0) !== 0);
    return any ? [{ model: model.replace(/\[[^\]]*\]$/, ""), usage }] : [];
  });
  return changed.length === 1 ? changed[0] : undefined;
}

/**
 * The snapshot: only the open frontier. Content of the session so far (messages, shapes, requests, Blocks, closed
 * Calls and ToolCalls, lane layouts) stays with the caller, who gives it back through the ContentLookup.
 */
function frontier(state: ParserState): ParserState {
  const lanes = Object.values(state.lanes);
  const compactions = Object.values(state.transcripts).flatMap((t) => t.openCompaction?.summaryCallId ?? []);
  const calls = new Set([
    ...Object.keys(state.pending),
    ...Object.keys(state.waiting),
    ...lanes.flatMap((l) => l.lastCallId ?? []),
    ...compactions,
  ]);
  const toolCalls = new Set(
    Object.values(state.toolCalls).flatMap((t) => (t.resultBlockHash === undefined ? [t.id] : [])),
  );
  const assistantIds = new Set(Object.values(state.transcripts).flatMap((t) => t.lastAssistantId ?? []));
  const pick = <T>(record: Record<string, T>, keys: Set<string>) => {
    const out: Record<string, T> = {};
    for (const key of keys) {
      const value = get(record, key);
      if (value !== undefined) put(out, key, value);
    }
    return out;
  };
  return structuredClone({
    ...state,
    messages: {},
    shapes: {},
    seenBlocks: {},
    groupSizes: {},
    toolSources: {},
    compactions: {},
    report: { unknownRecords: [], unreadable: [] },
    specs: pick(state.specs, calls),
    calls: pick(state.calls, calls),
    responses: pick(state.responses, calls),
    toolCalls: pick(state.toolCalls, toolCalls),
    toolUseTimes: pick(state.toolUseTimes, toolCalls),
    messageToolUses: pick(state.messageToolUses, assistantIds),
    assistant: pick(state.assistant, assistantIds),
    lanes: Object.fromEntries(lanes.map((lane) => [`${lane.sessionId}|${lane.key}`, coldLane(lane)])),
  });
}

/** A lane without its layout: rebuilt from the caller's open runs when it is next used. */
function coldLane(lane: Lane): Lane {
  const cold: Lane = {
    key: lane.key,
    sessionId: lane.sessionId,
    cold: true,
    shapeCount: lane.shapeCount,
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
  };
  if (lane.lastIndex !== undefined) cold.lastIndex = lane.lastIndex;
  if (lane.lastCallId !== undefined) cold.lastCallId = lane.lastCallId;
  if (lane.shapeKey !== undefined) cold.shapeKey = lane.shapeKey;
  return cold;
}
