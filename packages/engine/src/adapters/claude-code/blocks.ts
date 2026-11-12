/** Split a rebuilt request into Blocks with kind and source, in the order the provider reads them. */
import type { Block, BlockKind, BlockSource, RequestSection } from "@quantext/shared";
import { sha256Sorted } from "./hash.ts";
import type { Json, JsonObject } from "./json.ts";
import { obj, str } from "./json.ts";
import type { ContentNotes } from "./notes.ts";
import type { WireRequest } from "./rebuild.ts";

export interface RequestBlock {
  block: Block;
  section: RequestSection;
  message?: number;
  cacheBreakpoint: boolean;
  /** Set when the content block type is not known to the adapter. */
  unknownType?: string;
}

const KNOWN_CONTENT = new Set([
  "text",
  "thinking",
  "redacted_thinking",
  "tool_use",
  "tool_result",
  "image",
  "document",
]);
const AT_FILE_CALL =
  /^<system-reminder>\nCalled the (\S+) tool with the following input: (\{.*\})\n<\/system-reminder>/s;
const AT_FILE_RESULT = /^<system-reminder>\nResult of calling the (\S+) tool:/;

/** The Blocks of a request: tool schemas, then system blocks, then each message's content blocks. */
export function splitRequest(request: WireRequest, notes: ContentNotes): RequestBlock[] {
  const breakpoints = new Set(request.cacheBreakpoints.map((path) => path.join(".")));
  const out: RequestBlock[] = [];
  const push = (role: string, content: Json, section: RequestSection, path: string, message?: number) => {
    const { kind, source, unknownType } = classify(role, obj(content) ?? {}, context);
    const block: Block = { hash: blockHash(role, content), kind, source, content };
    const entry: RequestBlock = { block, section, cacheBreakpoint: breakpoints.has(path) };
    if (message !== undefined) entry.message = message;
    if (unknownType !== undefined) entry.unknownType = unknownType;
    out.push(entry);
  };
  const context: Context = { notes, toolUses: new Map(), lastFileCall: undefined };
  for (const [i, tool] of (request.shape?.tools ?? []).entries()) push("tools", tool, "tools", `tools.${i}`);
  for (const [i, block] of (request.shape?.system ?? []).entries()) push("system", block, "system", `system.${i}`);
  for (const [m, message] of request.messages.entries()) {
    for (const [b, block] of message.content.entries()) {
      push(message.role, block, "messages", `messages.${m}.content.${b}`, m);
    }
  }
  return out;
}

/** The hash of a content block, with the role it is sent in (so equal text as system and as user stays apart). */
export function blockHash(role: string, content: Json): string {
  return sha256Sorted({ role, block: content });
}

interface Context {
  notes: ContentNotes;
  /** Source of each tool use seen so far in the request, by tool use id. */
  toolUses: Map<string, BlockSource>;
  /** The last `@file` reminder of a tool call, for the result reminder after it. */
  lastFileCall: BlockSource | undefined;
}

interface Classified {
  kind: BlockKind;
  source: BlockSource;
  unknownType?: string;
}

function classify(role: string, block: JsonObject, context: Context): Classified {
  if (role === "tools") return { kind: "tool-schema", source: toolSource(str(block.name)) };
  const type = str(block.type) ?? "";
  if (!KNOWN_CONTENT.has(type)) return { kind: roleKind(role), source: {}, unknownType: type };
  if (role === "system") return { kind: "system", source: {} };
  switch (type) {
    case "thinking":
    case "redacted_thinking":
      return { kind: "reasoning", source: {} };
    case "tool_use": {
      const source = toolSource(str(block.name), obj(block.input));
      context.toolUses.set(str(block.id) ?? "", source);
      return { kind: "tool-call", source };
    }
    case "tool_result":
      return { kind: "tool-result", source: context.toolUses.get(str(block.tool_use_id) ?? "") ?? {} };
    case "image":
      return { kind: "image", source: {} };
    case "document":
      return { kind: "document", source: {} };
    default:
      return role === "assistant" ? { kind: "assistant", source: {} } : userText(str(block.text) ?? "", context);
  }
}

function userText(text: string, context: Context): Classified {
  if (context.notes.summaries.has(text)) return { kind: "summary", source: {} };
  const skill = context.notes.skills.get(text);
  if (skill !== undefined) return { kind: "reminder", source: { tool: "Skill", skill } };
  if (!text.startsWith("<system-reminder>")) return { kind: "user", source: {} };
  const call = AT_FILE_CALL.exec(text);
  if (call !== null) {
    const source = toolSource(call[1], parseObject(call[2] ?? ""));
    context.lastFileCall = source;
    return { kind: "reminder", source };
  }
  const result = AT_FILE_RESULT.exec(text);
  if (result !== null) {
    const last = context.lastFileCall;
    return { kind: "reminder", source: last !== undefined && last.tool === result[1] ? last : toolSource(result[1]) };
  }
  return { kind: "reminder", source: {} };
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
