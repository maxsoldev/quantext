import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import type { Manifest } from "./tools/manifest.ts";
import { summariseTranscript } from "./tools/manifest.ts";
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

  test.each(transcripts)("%s: blob and shape hashes match their content", (file) => {
    const rows = readFileSync(join(dir, file), "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line));
    for (const row of rows) {
      if (row.type === "api-request-blob") expect(sha256Sorted(row.message)).toBe(row.hash);
      if (row.type === "api-request-shape") expect(sha256Sorted(row.shape)).toBe(row.shapeHash);
    }
  });
});
