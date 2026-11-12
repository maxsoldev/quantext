/**
 * Strict reading of a request's query string and path segments: every parameter is named, typed and bounded, an
 * unknown or repeated one is refused. Errors name the parameter, never repeat its value.
 */

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
  }
}

export const badRequest = (message: string) => new HttpError(400, "bad-request", message);
export const notFound = (message = "not found") => new HttpError(404, "not-found", message);

/** Longest text parameter (a project path, a search). */
const MAX_TEXT = 1024;

/** The query string, with each name checked against `allowed` and given at most once. */
export function queryParams(search: URLSearchParams, allowed: readonly string[]): Params {
  const seen = new Set<string>();
  for (const name of search.keys()) {
    if (!allowed.includes(name)) throw badRequest(`unknown parameter ${safeName(name)}`);
    if (seen.has(name)) throw badRequest(`parameter ${name} is given more than once`);
    seen.add(name);
  }
  return new Params(search);
}

export class Params {
  readonly #search: URLSearchParams;
  constructor(search: URLSearchParams) {
    this.#search = search;
  }
  /** A whole number in [min, max]; undefined when absent. */
  int(name: string, min: number, max: number): number | undefined {
    const text = this.#search.get(name);
    return text === null ? undefined : integer(text, name, min, max);
  }
  /** One of `values`; undefined when absent. */
  oneOf<T extends string>(name: string, values: readonly T[]): T | undefined {
    const text = this.#search.get(name);
    if (text === null) return undefined;
    if (!(values as readonly string[]).includes(text)) throw badRequest(`${name} must be one of ${values.join(", ")}`);
    return text as T;
  }
  /** Text of 1 to `max` characters with no control characters; undefined when absent. */
  text(name: string, max = MAX_TEXT): string | undefined {
    const text = this.#search.get(name);
    return text === null ? undefined : checkText(text, name, max);
  }
}

/** A whole number written in decimal, in [min, max]. */
export function integer(text: string, name: string, min: number, max: number): number {
  if (!/^\d{1,15}$/.test(text)) throw badRequest(`${name} must be a whole number`);
  const n = Number(text);
  if (n < min || n > max) throw badRequest(`${name} must be from ${min} to ${max}`);
  return n;
}

export function checkText(text: string, name: string, max: number): string {
  if (text.length === 0 || text.length > max) throw badRequest(`${name} must have 1 to ${max} characters`);
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this refuses
  if (/[\u0000-\u001f\u007f]/.test(text)) throw badRequest(`${name} must not hold control characters`);
  return text;
}

/** A parameter name fit to show: only when it is a short plain word. */
function safeName(name: string): string {
  return /^[A-Za-z][A-Za-z0-9-]{0,31}$/.test(name) ? name : "(not shown)";
}
