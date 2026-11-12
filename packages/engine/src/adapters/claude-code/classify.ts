/**
 * Turn shapes and messages into Blocks with kind, source and estimate, once per content: a message or shape is
 * classified the first time a request holds it, then taken from a cache. A Block is reported when first seen.
 */
import type { Block, BlockKind, BlockSource, RequestSection } from "@quantext/shared";
import type { Estimate, Estimator } from "../../core/estimate.ts";
import { blockText, isDeferredSchema, KNOWN_CONTENT_TYPES, toolReferences } from "../../providers/anthropic/content.ts";
import { sha256Sorted } from "./hash.ts";
import type { Json, JsonObject } from "./json.ts";
import { obj, str } from "./json.ts";
import type { Content } from "./lookup.ts";
import { get, put } from "./records.ts";
import type { ParserState } from "./state.ts";

export interface BlockRef {
  hash: string;
  kind: BlockKind;
  /** The index of the content block in its message, or in its section of the shape. */
  contentIndex: number;
  estimate: Estimate;
  /** Tools that this Block loads with a tool reference. */
  references: string[];
  /** For a tool result: the tool use it answers. */
  toolUseId?: string;
}

export interface ShapeRefs {
  /** Tool schemas sent in the tools section, then the system blocks. */
  refs: BlockRef[];
  sections: RequestSection[];
  toolCount: number;
  /** The hash of the Blocks of the shape that are always sent: Calls with the same key share them. */
  key: string;
  /** Deferred tool schemas by tool name: each is sent after the tool reference that loads it. */
  deferred: Record<string, BlockRef>;
}

export interface Classifier {
  message(hash: string): BlockRef[] | undefined;
  shape(hash: string): ShapeRefs | undefined;
  /** The gap Block that stands for a message that is not in the log. */
  gap(messageHash: string): BlockRef;
}

/** The display text of a gap Block. */
export function gapText(messageHash: string): string {
  return `Message ${messageHash} is not in the log`;
}

/** A Block seen for the first time, and the content block type the adapter does not know, if so. */
export type BlockSink = (block: Block, unknownType: string | undefined) => void;

const AT_FILE_CALL =
  /^<system-reminder>\nCalled the (\S+) tool with the following input: (\{.*\})\n<\/system-reminder>/s;
const AT_FILE_RESULT = /^<system-reminder>\nResult of calling the (\S+) tool:/;

export function createClassifier(store: Content, sink: BlockSink, estimator: Estimator): Classifier {
  const messages = new Map<string, BlockRef[]>();
  const shapes = new Map<string, ShapeRefs>();
  const ref = (role: string, content: Json, contentIndex: number): BlockRef => {
    const hash = blockHash(role, content);
    const fresh = !store.seen(hash);
    const { kind, source, unknownType } = classify(role, obj(content) ?? {}, store, fresh);
    const block: Block = { hash, kind, source, text: blockText(content), content };
    if (fresh) {
      store.markSeen(hash);
      sink(block, unknownType);
    }
    const out: BlockRef = { hash, kind, contentIndex, estimate: estimator(block), references: toolReferences(content) };
    const toolUseId = kind === "tool-result" ? str(obj(content)?.tool_use_id) : undefined;
    if (toolUseId !== undefined) out.toolUseId = toolUseId;
    return out;
  };
  return {
    message(hash) {
      const cached = messages.get(hash);
      if (cached !== undefined) return cached;
      const message = store.message(hash);
      if (message === undefined) return undefined;
      const refs = message.content.map((content, i) => ref(message.role, content, i));
      messages.set(hash, refs);
      return refs;
    },
    gap(messageHash) {
      const content = { type: "gap", message: messageHash };
      const hash = blockHash("gap", content);
      if (!store.seen(hash)) {
        store.markSeen(hash);
        sink({ hash, kind: "gap", source: {}, text: gapText(messageHash), content }, undefined);
      }
      // No estimate: the gap takes what the other new Blocks leave of the exact change.
      return { hash, kind: "gap", contentIndex: 0, estimate: { tokens: 0, method: "unknown" }, references: [] };
    },
    shape(hash) {
      const cached = shapes.get(hash);
      if (cached !== undefined) return cached;
      const shape = store.shape(hash);
      if (shape === undefined) return undefined;
      const refs: BlockRef[] = [];
      const sections: RequestSection[] = [];
      const deferred: Record<string, BlockRef> = {};
      for (const [i, tool] of shape.tools.entries()) {
        const r = ref("tools", tool, i);
        if (isDeferredSchema(tool)) {
          put(deferred, str(obj(tool)?.name) ?? "", r);
          continue;
        }
        refs.push(r);
        sections.push("tools");
      }
      const toolCount = refs.length;
      for (const [i, block] of shape.system.entries()) {
        refs.push(ref("system", block, i));
        sections.push("system");
      }
      const result = { refs, sections, toolCount, key: sha256Sorted(refs.map((r) => r.hash)), deferred };
      shapes.set(hash, result);
      return result;
    },
  };
}

/** The hash of a content block, with the role it is sent in (so equal text as system and as user stays apart). */
export function blockHash(role: string, content: Json): string {
  return sha256Sorted({ role, block: content });
}

interface Classified {
  kind: BlockKind;
  source: BlockSource;
  unknownType?: string;
}

/** Kind and source of one content block. `fresh`: first seen, so it may update what later blocks refer to. */
function classify(role: string, block: JsonObject, store: Content, fresh: boolean): Classified {
  if (role === "tools") return { kind: "tool-schema", source: toolSource(str(block.name)) };
  const type = str(block.type) ?? "";
  if (!KNOWN_CONTENT_TYPES.has(type)) return { kind: roleKind(role), source: {}, unknownType: type };
  if (role === "system") return { kind: "system", source: {} };
  switch (type) {
    case "thinking":
    case "redacted_thinking":
      return { kind: "reasoning", source: {} };
    case "tool_use": {
      const source = toolSource(str(block.name), obj(block.input));
      store.putToolSource(str(block.id) ?? "", source);
      return { kind: "tool-call", source };
    }
    case "tool_result": {
      const id = str(block.tool_use_id) ?? "";
      return { kind: "tool-result", source: store.toolCall(id)?.source ?? store.toolSource(id) ?? {} };
    }
    case "image":
      return { kind: "image", source: {} };
    case "document":
      return { kind: "document", source: {} };
    default:
      return role === "assistant"
        ? { kind: "assistant", source: {} }
        : userText(str(block.text) ?? "", store.state, fresh);
  }
}

/** A user-role text, with the source of the attachment that rendered it, when one did (exact text only). */
function userText(text: string, state: ParserState, fresh: boolean): Classified {
  const plain = plainUserText(text, state, fresh);
  const attached = get(state.attachments, attachedTextHash(text));
  if (attached === undefined || plain.kind === "summary") return plain;
  const source: BlockSource = { ...plain.source, attachment: attached.type };
  if (source.filePath === undefined && attached.path !== undefined) source.filePath = attached.path;
  return { kind: "reminder", source };
}

function plainUserText(text: string, state: ParserState, fresh: boolean): Classified {
  const hash = textHash(text);
  if (get(state.summaries, hash) !== undefined) return { kind: "summary", source: {} };
  const skill = get(state.skills, hash);
  if (skill !== undefined) return { kind: "reminder", source: { tool: "Skill", skill } };
  if (!text.startsWith("<system-reminder>")) return { kind: "user", source: {} };
  const call = AT_FILE_CALL.exec(text);
  if (call !== null) {
    const source = toolSource(call[1], parseObject(call[2] ?? ""));
    if (fresh) state.lastFileCall = source;
    return { kind: "reminder", source };
  }
  const result = AT_FILE_RESULT.exec(text);
  if (result !== null) {
    const last = state.lastFileCall;
    return { kind: "reminder", source: last !== undefined && last.tool === result[1] ? last : toolSource(result[1]) };
  }
  return { kind: "reminder", source: {} };
}

/** The key of an attached text: the text without white space around it (the harness may add a newline). */
export function attachedTextHash(text: string): string {
  return textHash(text.trim());
}

/** The key under which the state remembers a text (summaries, skills). */
export function textHash(text: string): string {
  return sha256Sorted(text);
}

/** The source of a tool: its name, its MCP server (`mcp__<server>__<tool>`), the file and skill in its input. */
export function toolSource(name: string | undefined, input?: JsonObject): BlockSource {
  if (name === undefined) return {};
  const source: BlockSource = { tool: name };
  const server = /^mcp__(.+?)__/.exec(name)?.[1];
  if (server !== undefined) source.mcpServer = server;
  const filePath = str(input?.file_path);
  if (filePath !== undefined) source.filePath = filePath;
  const skill = str(input?.skill);
  if (name === "Skill" && skill !== undefined) source.skill = skill;
  return source;
}

function roleKind(role: string): BlockKind {
  if (role === "system") return "system";
  return role === "assistant" ? "assistant" : "user";
}

function parseObject(text: string): JsonObject | undefined {
  try {
    return obj(JSON.parse(text));
  } catch {
    return undefined; // Not JSON: the reminder still counts, only without a file path.
  }
}
