import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import type { Manifest } from "./tools/manifest.ts";
import { compactionsOf, summariseTranscript } from "./tools/manifest.ts";
import { sha256Sorted } from "./tools/normalise.ts";

const HARNESS_DIR = join(dirname(fileURLToPath(import.meta.url)), "claude-code");

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

const scenarios = existsSync(HARNESS_DIR)
  ? readdirSync(HARNESS_DIR).flatMap((version) =>
      readdirSync(join(HARNESS_DIR, version)).map((scenario) => ({ version, scenario })),
    )
  : [];

test("there are recorded fixtures", () => {
  expect(scenarios.length).toBeGreaterThan(0);
});

describe.each(scenarios)("fixture $version/$scenario", ({ version, scenario }) => {
  const dir = join(HARNESS_DIR, version, scenario);
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as Manifest;
  const transcripts = filesUnder(dir)
    .filter((path) => path.endsWith(".jsonl"))
    .map((path) => relative(dir, path))
    .sort();

  test("the manifest names this scenario and harness version", () => {
    expect(manifest.scenario).toBe(scenario);
    expect(manifest.harnessVersion).toBe(version);
  });

  test("the manifest lists exactly the transcripts in the folder", () => {
    expect(Object.keys(manifest.transcripts).sort()).toEqual(transcripts);
  });

  test.each(transcripts)("%s parses as JSONL and matches the manifest counts", (file) => {
    expect(summariseTranscript(file, readFileSync(join(dir, file), "utf8"))).toEqual(manifest.transcripts[file]);
  });

  test("the manifest lists each compaction with the derived usage of its summarising call", () => {
    const found = Object.fromEntries(
      transcripts
        .map((file) => [file, compactionsOf(readFileSync(join(dir, file), "utf8"))] as const)
        .filter(([, list]) => list.length > 0),
    );
    expect(manifest.compactions).toEqual(found);
  });

  const rowsOf = (file: string) =>
    readFileSync(join(dir, file), "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line));

  test("the manifest reports no unresolved tail hashes", () => {
    expect(manifest.unresolvedTailHashes).toBe(0);
  });

  test.each(transcripts)("%s: every tail hash names a message, every shape hash a shape", (file) => {
    const { messages, shapes } = wireIndex(transcripts.flatMap(rowsOf));
    for (const row of rowsOf(file)) {
      if (row.type !== "api-request") continue;
      expect(shapes.has(row.shapeHash), `shape of call ${row.id}`).toBe(true);
      for (const hash of row.tail) expect(messages.has(hash), `tail of call ${row.id}`).toBe(true);
    }
  });

  test.each(transcripts)("%s: each call's base is an earlier call, and keep fits in it", (file) => {
    const lengths = new Map<string, number>(); // call id -> message count
    for (const row of rowsOf(file)) {
      if (row.type !== "api-request") continue;
      if (row.base === undefined) {
        expect(row.keep, `call ${row.id} has no base`).toBe(0);
      } else {
        expect(lengths.has(row.base), `base of call ${row.id}`).toBe(true);
        expect(row.keep).toBeLessThanOrEqual(lengths.get(row.base) ?? 0);
      }
      lengths.set(row.id, row.keep + row.tail.length);
    }
  });

  test.each(transcripts)("%s: blob and shape hashes match their content", (file) => {
    const rows = rowsOf(file);
    for (const row of rows) {
      if (row.type === "api-request-blob") expect(sha256Sorted(row.message)).toBe(row.hash);
      if (row.type === "api-request-shape") expect(sha256Sorted(row.shape)).toBe(row.shapeHash);
    }
  });
});

/**
 * The messages a tail hash may name, by Claude Code's rules (independent of the normaliser): an
 * `api-request-blob` row; a `user` row (role and content; a string prompt also as one text block); adjacent user
 * rows joined into one message; an assistant message, which is every `assistant` row of one `message.id`, in order.
 */
// biome-ignore lint/suspicious/noExplicitAny: transcript rows are untyped JSON in this test
function wireIndex(rows: any[]): { messages: Set<string>; shapes: Set<string> } {
  const messages = new Set<string>();
  const shapes = new Set<string>();
  const assistant = new Map<string, unknown[]>();
  let userRun: unknown[][] = [];
  for (const row of rows) {
    if (row.type === "assistant") userRun = [];
    if (row.type === "user" && row.message) {
      const { content } = row.message;
      userRun.push(typeof content === "string" ? [{ type: "text", text: content }] : content);
      for (let start = 0; start < userRun.length - 1; start++) {
        const joined = userRun.slice(start).flat();
        messages.add(sha256Sorted({ role: "user", content: joined } as Parameters<typeof sha256Sorted>[0]));
      }
    }
    if (row.type === "api-request-blob") messages.add(row.hash);
    if (row.type === "api-request-shape") shapes.add(row.shapeHash);
    if (row.type === "user" && row.message) {
      const { role, content } = row.message;
      messages.add(sha256Sorted({ role, content }));
      if (typeof content === "string") messages.add(sha256Sorted({ role, content: [{ type: "text", text: content }] }));
    }
    if (row.type === "assistant" && row.message) {
      assistant.set(row.message.id, [...(assistant.get(row.message.id) ?? []), ...row.message.content]);
    }
  }
  for (const content of assistant.values()) {
    messages.add(sha256Sorted({ role: "assistant", content } as Parameters<typeof sha256Sorted>[0]));
  }
  return { messages, shapes };
}
