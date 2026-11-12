/** Claude Code's content hash: sha256 of the JSON with object keys sorted at every level. */
import { createHash } from "node:crypto";
import type { Json } from "./json.ts";
import { isObject } from "./json.ts";

export function sha256Sorted(value: Json): string {
  return createHash("sha256")
    .update(JSON.stringify(sortKeys(value)))
    .digest("hex");
}

function sortKeys(value: Json): Json {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortKeys(value[key] ?? null)]),
  );
}
