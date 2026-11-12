/** Small readers for untyped JSON from the transcript. Each returns undefined when the value has another type. */

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

export function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function obj(value: unknown): JsonObject | undefined {
  return isObject(value) ? value : undefined;
}

export function arr(value: unknown): Json[] | undefined {
  return Array.isArray(value) ? (value as Json[]) : undefined;
}
