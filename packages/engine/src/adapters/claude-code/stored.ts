/**
 * The Claude Code records as the store keeps them: a message (`m:`) and a shape (`s:`) become lists of content
 * blocks by Block hash (the hash the classifier gives each block), so the store keeps each content block once.
 */
import { createHash } from "node:crypto";
import type { AdapterRecord, ContentPart, JsonValue, Media, StoreCodec, StoredRecord } from "@quantext/shared";
import { blockText } from "../../providers/anthropic/content.ts";
import { blockHash, gapText } from "./classify.ts";
import type { Json, JsonObject } from "./json.ts";
import { isObject, str } from "./json.ts";
import type { WireMessage, WireShape } from "./state.ts";

const parts = (role: string, content: readonly Json[]): ContentPart[] =>
  content.map((c) => ({ hash: blockHash(role, c), content: c }));

/** The adapter's version: bump it when a change reads logs differently, so that stored logs are read again. */
export const ADAPTER_VERSION = 6;

/** Base64 data shorter than this stays in the content. */
const MEDIA_MIN_CHARS = 128;

export const claudeCodeCodec: StoreCodec = {
  version: ADAPTER_VERSION,
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
  packContent(content) {
    const media: Media[] = [];
    return { content: mapSources(content, (source) => takeMedia(source, media)), media };
  },
  unpackContent(content, bytes) {
    return mapSources(content, (source) => {
      const hash = str(source.$media);
      if (hash === undefined || source.data !== undefined) return source;
      const { $media: _, ...rest } = source;
      return { ...rest, data: Buffer.from(bytes(hash)).toString("base64") };
    });
  },
  text(content) {
    const gap = isObject(content) && content.type === "gap" ? str(content.message) : undefined;
    return gap === undefined ? blockText(content) : gapText(gap);
  },
};

/** The content with every `{ type: "base64", … }` source object passed through `map`. */
function mapSources(value: JsonValue, map: (source: JsonObject) => JsonObject): JsonValue {
  if (Array.isArray(value)) return value.map((v) => mapSources(v, map));
  if (!isObject(value)) return value;
  const out: JsonObject = {};
  for (const [key, child] of Object.entries(value)) out[key] = mapSources(child ?? null, map);
  return out.type === "base64" ? map(out) : out;
}

/** A base64 source of canonical, long data, as a reference to its decoded bytes (added to `media`). */
function takeMedia(source: JsonObject, media: Media[]): JsonObject {
  const data = str(source.data);
  const mediaType = str(source.media_type);
  if (data === undefined || mediaType === undefined || data.length < MEDIA_MIN_CHARS) return source;
  const bytes = Buffer.from(data, "base64");
  if (bytes.toString("base64") !== data) return source; // not canonical: kept as text, so it comes back the same
  const hash = createHash("sha256").update(bytes).digest("hex");
  media.push({ hash, mediaType, bytes });
  const { data: _, ...rest } = source;
  return { ...rest, $media: hash };
}
