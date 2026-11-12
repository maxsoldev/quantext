/**
 * Rewrite a recorded session's machine-specific strings (temp dir paths) to stable placeholders of the same
 * length (so content sizes and token estimates stay as recorded), and keep the
 * content hashes that the context rebuild depends on valid: blob hashes, the hashes in `tail`, and `shapeHash`.
 * Claude Code hashes a message or a shape as sha256 of its JSON with sorted keys. `requestDigest` covers the full
 * wire request, which the log does not hold exactly, so it stays as recorded (an opaque id).
 */
import { createHash } from "node:crypto";

export type Replacement = readonly [from: string, to: string];

export interface NormaliseResult {
  /** Same keys as the input, normalised text as values. */
  files: Record<string, string>;
  /** Tail hashes that match no blob, user or assistant row, before or after; left as recorded. */
  unresolvedTailHashes: number;
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Row = { [key: string]: Json };

/** Normalise all files of one recorded session (main transcript, subagent transcripts, metadata). */
export function normaliseSession(input: Record<string, string>, replacements: readonly Replacement[]): NormaliseResult {
  for (const [from, to] of replacements) {
    if (from.length !== to.length) throw new Error(`Replacement for ${to} must have the same length as the original`);
  }
  const replace = (text: string) => replacements.reduce((acc, [from, to]) => acc.replaceAll(from, to), text);
  const parsed = Object.entries(input).map(([name, text]) => ({ name, text, rows: parseRows(name, text) }));

  const hashMap = new Map<string, string>(); // recorded hash -> normalised hash
  const known = new Set<string>(); // every message hash before normalisation
  const changed = new Map<Row, Row>();
  const remember = ([before, after]: [string, string]) => {
    known.add(before);
    if (before !== after) hashMap.set(before, after);
  };
  for (const { rows } of parsed) {
    const split = new Map<string, { before: Json[]; after: Json[] }>(); // assistant message id -> content parts
    for (const row of rows ?? []) {
      if (row === undefined) continue;
      const next = mapStrings(row, replace) as Row;
      const isChanged = JSON.stringify(next) !== JSON.stringify(row);
      if (isChanged) changed.set(row, next);
      contentHashes(row, next, isChanged).forEach(remember);
      const id = row.type === "assistant" && isObject(row.message) ? row.message.id : undefined;
      if (typeof id === "string" && isObject(row.message) && isObject(next.message)) {
        const parts = split.get(id) ?? { before: [], after: [] };
        parts.before.push(...asArray(row.message.content));
        parts.after.push(...asArray(next.message.content));
        split.set(id, parts);
      }
    }
    // Claude Code writes one assistant row per content block; the API message is all rows of one id, in order.
    for (const { before, after } of split.values()) {
      remember([wireHash("assistant", before), wireHash("assistant", after)]);
    }
  }

  let unresolvedTailHashes = 0;
  const files: Record<string, string> = {};
  for (const { name, text, rows } of parsed) {
    if (rows === undefined) {
      files[name] = replace(text);
      continue;
    }
    const lines = text.split("\n");
    files[name] = lines
      .map((line, index) => {
        const row = rows[index];
        if (row === undefined) return line;
        const next = structuredClone(changed.get(row) ?? row);
        let touched = changed.has(row);
        if (next.type === "api-request") {
          const tail = Array.isArray(next.tail) ? next.tail : [];
          for (const hash of tail) if (typeof hash === "string" && !known.has(hash)) unresolvedTailHashes++;
          const remapped = tail.map((hash) => (typeof hash === "string" ? (hashMap.get(hash) ?? hash) : hash));
          if (JSON.stringify(remapped) !== JSON.stringify(tail)) [next.tail, touched] = [remapped, true];
          const shape = typeof next.shapeHash === "string" ? hashMap.get(next.shapeHash) : undefined;
          if (shape !== undefined) [next.shapeHash, touched] = [shape, true];
        }
        return touched ? JSON.stringify(next) : line;
      })
      .join("\n");
  }
  return { files, unresolvedTailHashes };
}

/**
 * The recording root as Claude Code writes it (resolved, and dash-encoded in project folder names), each mapped to
 * `/fixture-000…` of the same length. Other spellings (such as `/tmp` for `/private/tmp`) are not mapped; the
 * leftover check of the recorder catches them.
 */
export function replacementsFor(root: string): Replacement[] {
  const placeholder = `/fixture-${"0".repeat(Math.max(0, root.length - "/fixture-".length))}`;
  if (placeholder.length !== root.length) throw new Error("Recording root is too short for the placeholder");
  const encode = (path: string) => path.replace(/[^A-Za-z0-9]/g, "-");
  return [
    [root, placeholder],
    [encode(root), encode(placeholder)],
  ];
}

/** Rows by line index for `.jsonl` files (blank lines stay undefined); undefined for other files. */
function parseRows(name: string, text: string): (Row | undefined)[] | undefined {
  if (!name.endsWith(".jsonl")) return undefined;
  return text.split("\n").map((line, index) => {
    if (line.trim() === "") return undefined;
    try {
      return JSON.parse(line) as Row;
    } catch (error) {
      throw new Error(`${name}:${index + 1}: not JSON (${(error as Error).message})`);
    }
  });
}

/**
 * [hash before, hash after] for each content hash a row defines. A changed blob or shape row gets its hash field
 * recomputed; an unchanged one keeps the recorded hash, so a hash scheme change in the harness cannot corrupt it.
 */
function contentHashes(row: Row, next: Row, isChanged: boolean): [string, string][] {
  if (row.type === "api-request-blob" && typeof row.hash === "string") {
    if (isChanged) next.hash = sha256Sorted(next.message ?? null);
    return [[row.hash, isChanged ? (next.hash as string) : row.hash]];
  }
  if (row.type === "api-request-shape" && typeof row.shapeHash === "string") {
    if (isChanged) next.shapeHash = sha256Sorted(next.shape ?? null);
    return [[row.shapeHash, isChanged ? (next.shapeHash as string) : row.shapeHash]];
  }
  if ((row.type === "user" || row.type === "assistant") && isObject(row.message) && isObject(next.message)) {
    const wire = (m: Row) => wireHash(m.role ?? null, m.content ?? null);
    // A string prompt reaches the API as one text block.
    const block = (m: Row) => wireHash(m.role ?? null, [{ type: "text", text: m.content ?? "" }]);
    const pairs: [string, string][] = [[wire(row.message), wire(next.message)]];
    if (typeof row.message.content === "string") pairs.push([block(row.message), block(next.message)]);
    return pairs;
  }
  return [];
}

/** The hash of a message as the API received it: role and content only. */
function wireHash(role: Json, content: Json): string {
  return sha256Sorted({ role, content });
}

function asArray(value: Json | undefined): Json[] {
  return Array.isArray(value) ? value : value === undefined ? [] : [value];
}

/** sha256 of the JSON with object keys sorted at every level: Claude Code's content hash. */
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

function mapStrings(value: Json, replace: (text: string) => string): Json {
  if (typeof value === "string") return replace(value);
  if (Array.isArray(value)) return value.map((item) => mapStrings(item, replace));
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [replace(key), mapStrings(item, replace)]));
}

function isObject(value: Json | undefined): value is { [key: string]: Json } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
