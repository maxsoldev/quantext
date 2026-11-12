/**
 * The Claude Code records as the store keeps them: a message (`m:`) and a shape (`s:`) become lists of content
 * blocks by Block hash (the hash the classifier gives each block), so the store keeps each content block once.
 */
import type { AdapterRecord, ContentPart, JsonValue, RecordCodec, StoredRecord } from "@quantext/shared";
import { blockHash } from "./classify.ts";
import type { Json } from "./json.ts";
import type { WireMessage, WireShape } from "./state.ts";

const parts = (role: string, content: readonly Json[]): ContentPart[] =>
  content.map((c) => ({ hash: blockHash(role, c), content: c }));

export const claudeCodeRecords: RecordCodec = {
  pack({ key, value }: AdapterRecord): StoredRecord {
    if (key.startsWith("m:")) {
      const message = value as unknown as WireMessage;
      return { kind: "message", key, role: message.role, parts: parts(message.role, message.content) };
    }
    if (key.startsWith("s:")) {
      const shape = value as unknown as WireShape;
      return { kind: "shape", key, tools: parts("tools", shape.tools), system: parts("system", shape.system) };
    }
    return { kind: "value", key, value };
  },
  unpack(stored: StoredRecord): JsonValue {
    switch (stored.kind) {
      case "message":
        return { role: stored.role, content: stored.parts.map((p) => p.content) };
      case "shape":
        return { system: stored.system.map((p) => p.content), tools: stored.tools.map((p) => p.content) };
      case "value":
        return stored.value;
    }
  },
};
