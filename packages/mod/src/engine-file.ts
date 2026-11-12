/**
 * What the mod reads from the engine: `engine.json` and `/health` (ADR 25). Another process may have written
 * either, so each field is checked, the `url` field is never read (the address is built from the port alone),
 * and text from them is made printable before it is shown.
 */
import type { EngineFile, Health } from "@quantext/shared";

/** The engine file's fields the mod uses. */
export type EngineAddress = Pick<EngineFile, "port" | "pid" | "version">;

const API_VERSION = 1;
const VERSION = /^[0-9A-Za-z.+-]{1,64}$/;

const isPort = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 65_535;
const isPid = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 1;

function object(text: string): Record<string, unknown> | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined; // not JSON: not an engine's file or answer
  }
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** The port, pid and version of an `engine.json`'s text, or undefined when any of them is not one. */
export function parseEngineFile(text: string): EngineAddress | undefined {
  const f = object(text);
  if (f === undefined || f.apiVersion !== API_VERSION) return undefined;
  const { port, pid, version } = f;
  if (!isPort(port) || !isPid(pid) || typeof version !== "string" || !VERSION.test(version)) return undefined;
  return { port, pid, version };
}

/** The pid and version of a `/health` answer, or undefined when it is not the engine's. */
export function parseHealth(text: string): Pick<Health, "pid" | "version"> | undefined {
  const h = object(text);
  if (h === undefined || h.ok !== true || h.apiVersion !== API_VERSION) return undefined;
  const { pid, version } = h;
  if (!isPid(pid) || typeof version !== "string") return undefined;
  return { pid, version: printable(version).slice(0, 64) };
}

/** The engine's address, from the port alone. */
export function engineUrl(port: number): string {
  if (!isPort(port)) throw new Error(`not a port: ${port}`);
  return `http://127.0.0.1:${port}/`;
}

/** Text from another process, fit to show: each control character (escape codes) becomes `?`. */
export function printable(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this replaces
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, "?");
}

/** The version in the bundled engine's package.json, or undefined when it has none. */
export function parseEngineVersion(text: string): string | undefined {
  const version = object(text)?.version;
  return typeof version === "string" && VERSION.test(version) ? version : undefined;
}
