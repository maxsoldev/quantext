/**
 * Rebuild the exact request of each logged call: its Shape (system blocks and tool schemas) and its message list.
 * The messages of a call are the first `keep` messages of its `base` call, then the messages named by `tail`.
 */
import type { Json, JsonObject } from "./json.ts";
import { arr, num, obj, str } from "./json.ts";
import type { Row } from "./rows.ts";
import { wireMessages } from "./wire.ts";

export interface WireMessage {
  role: string;
  content: Json[];
}

export interface WireShape {
  system: Json[];
  tools: Json[];
}

export interface WireRequest {
  shape?: WireShape;
  messages: WireMessage[];
  /** Paths in the request that carry a cache_control marker, such as `["messages", 3, "content", 0]`. */
  cacheBreakpoints: (string | number)[][];
  /** What could not be resolved, one reason each. Empty when the request is complete. */
  missing: string[];
}

/** The rebuilt request of every `api-request` row, by request id. `rows` may span several transcripts. */
export function rebuildRequests(rows: readonly Row[]): Map<string, WireRequest> {
  const messages = wireMessages(rows);
  const shapes = new Map<string, WireShape>();
  for (const row of rows) {
    const hash = str(row.data.shapeHash);
    const shape = obj(row.data.shape);
    if (row.type === "api-request-shape" && hash !== undefined && shape !== undefined) shapes.set(hash, shapeOf(shape));
  }
  const requests = new Map<string, WireRequest>();
  for (const row of rows) {
    if (row.type !== "api-request") continue;
    const id = str(row.data.id);
    if (id !== undefined) requests.set(id, requestOf(row.data, requests, messages, shapes));
  }
  return requests;
}

function requestOf(
  data: JsonObject,
  earlier: ReadonlyMap<string, WireRequest>,
  messages: ReadonlyMap<string, WireMessage>,
  shapes: ReadonlyMap<string, WireShape>,
): WireRequest {
  const missing: string[] = [];
  const keep = num(data.keep) ?? 0;
  const baseId = str(data.base);
  const base = baseId === undefined ? undefined : earlier.get(baseId);
  if (baseId !== undefined && base === undefined) missing.push(`base call ${baseId} is not in the log`);
  if (keep > (base?.messages.length ?? 0)) missing.push(`keep ${keep} is more than the base call's messages`);
  const kept = base?.messages.slice(0, keep) ?? [];
  const tail: WireMessage[] = [];
  for (const hash of arr(data.tail) ?? []) {
    const message = typeof hash === "string" ? messages.get(hash) : undefined;
    if (message === undefined) missing.push(`message ${String(hash)} is not in the log`);
    else tail.push(message);
  }
  const shapeHash = str(data.shapeHash);
  const shape = shapeHash === undefined ? undefined : shapes.get(shapeHash);
  if (shape === undefined) missing.push(`shape ${shapeHash ?? "(none)"} is not in the log`);
  if (base !== undefined && base.missing.length > 0) missing.push(`base call ${baseId} is incomplete`);
  const request: WireRequest = { messages: [...kept, ...tail], cacheBreakpoints: breakpointsOf(data), missing };
  if (shape !== undefined) request.shape = shape;
  return request;
}

function shapeOf(shape: JsonObject): WireShape {
  return { system: arr(shape.system) ?? [], tools: arr(shape.tools) ?? [] };
}

function breakpointsOf(data: JsonObject): (string | number)[][] {
  return (arr(data.cacheControl) ?? []).flatMap((entry) => {
    const path = arr(obj(entry)?.path);
    return path === undefined
      ? []
      : [path.filter((p): p is string | number => typeof p === "string" || typeof p === "number")];
  });
}
