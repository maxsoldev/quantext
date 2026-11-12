/** Read the recorded Claude Code fixtures (fixtures/claude-code/<version>/<scenario>/) for the adapter tests. */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ClaudeCodeTranscripts } from "../src/adapters/claude-code/index.ts";

export const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/claude-code");

export interface Scenario {
  version: string;
  name: string;
  dir: string;
}

/** Every recorded scenario of every harness version. */
export function scenarios(): Scenario[] {
  return readdirSync(FIXTURES_DIR).flatMap((version) =>
    readdirSync(join(FIXTURES_DIR, version)).map((name) => ({ version, name, dir: join(FIXTURES_DIR, version, name) })),
  );
}

/** The main transcript and the subagent transcripts of one scenario, as text. */
export function transcriptsOf(scenario: string, version = "2.1.322"): ClaudeCodeTranscripts {
  const dir = join(FIXTURES_DIR, version, scenario);
  const main = readdirSync(dir).find((name) => name.endsWith(".jsonl"));
  if (main === undefined) throw new Error(`no transcript in ${dir}`);
  const agentsDir = join(dir, main.replace(/\.jsonl$/, ""), "subagents");
  const subagents = existsSync(agentsDir)
    ? readdirSync(agentsDir)
        .filter((name) => name.endsWith(".jsonl"))
        .sort()
        .map((name) => {
          const meta = join(agentsDir, name.replace(/\.jsonl$/, ".meta.json"));
          const text = readFileSync(join(agentsDir, name), "utf8");
          return existsSync(meta) ? { text, meta: readFileSync(meta, "utf8") } : { text };
        })
    : [];
  return { main: readFileSync(join(dir, main), "utf8"), subagents };
}

/** The JSON rows of a scenario's main transcript, for expected values read straight from the log. */
export function mainRows(scenario: string, version = "2.1.322"): Record<string, unknown>[] {
  return transcriptsOf(scenario, version)
    .main.split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}
