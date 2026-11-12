/**
 * A bundled engine over a temp copy of the fixtures, one per test file: each scenario is a project folder, as
 * after-step-7.md shows. `append` writes lines to a copied transcript, as a live session does.
 */
import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test as base } from "@playwright/test";

const repo = join(import.meta.dirname, "..");
const ENGINE = join(repo, "packages", "engine", "dist", "engine.js");
const FIXTURES = join(repo, "fixtures", "claude-code", "2.1.322");

export interface Engine {
  url: string;
  /** The transcript of a scenario's main Session in the temp root. */
  transcript(scenario: string): string;
  stop(): Promise<void>;
}

export interface EngineOptions {
  /** Scenarios to copy (default: all). */
  scenarios?: string[];
  /** Copy only this many lines of a scenario's main transcript, to append the rest later. */
  firstLines?: Record<string, number>;
}

export async function startEngine(options: EngineOptions = {}): Promise<Engine> {
  if (!existsSync(ENGINE)) throw new Error("no dist/engine.js: run pnpm build first");
  const work = mkdtempSync(join(tmpdir(), "qx-e2e-"));
  const root = join(work, "root");
  const scenarios = options.scenarios ?? readdirSync(FIXTURES);
  for (const s of scenarios) {
    const dir = join(root, "projects", `-fixture-${s}`);
    mkdirSync(dir, { recursive: true });
    cpSync(join(FIXTURES, s), dir, { recursive: true });
    rmSync(join(dir, "manifest.json"));
    const keep = options.firstLines?.[s];
    if (keep !== undefined) {
      const file = mainTranscript(dir);
      const lines = readFileSync(file, "utf8").split(/(?<=\n)/);
      rmSync(file);
      appendFileSync(file, lines.slice(0, keep).join(""));
    }
  }
  const dataDir = join(work, "data");
  const child = spawn(
    process.execPath,
    [ENGINE, "serve", "--root", root, "--data-dir", dataDir, "--port", "0", "--live", "always"],
    {
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const port = await until(() => {
    const file = join(dataDir, "engine.json");
    return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as { port: number }).port : undefined;
  });
  return {
    url: `http://127.0.0.1:${port}`,
    transcript: (s) => mainTranscript(join(root, "projects", `-fixture-${s}`)),
    stop: () => stop(child, work),
  };
}

/** Append the lines of a scenario's fixture transcript after the first `from`, as the harness would. */
export function appendRest(engine: Engine, scenario: string, from: number): void {
  const source = mainTranscript(join(FIXTURES, scenario));
  const lines = readFileSync(source, "utf8").split(/(?<=\n)/);
  appendFileSync(engine.transcript(scenario), lines.slice(from).join(""));
}

/** The lines of a scenario's main fixture transcript. */
export function fixtureLines(scenario: string): number {
  return readFileSync(mainTranscript(join(FIXTURES, scenario)), "utf8").split(/(?<=\n)/).length;
}

function mainTranscript(dir: string): string {
  const name = readdirSync(dir).find((n) => n.endsWith(".jsonl"));
  if (name === undefined) throw new Error(`no transcript in ${dir}`);
  return join(dir, name);
}

async function stop(child: ChildProcess, work: string): Promise<void> {
  if (child.exitCode === null) {
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGTERM");
    await exited;
  }
  rmSync(work, { recursive: true, force: true });
}

async function until<T>(fn: () => T | undefined, timeoutMs = 15_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = fn();
    if (value !== undefined) return value;
    if (Date.now() > end) throw new Error("the engine did not start");
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** A test with an engine over all the fixtures, shared by the tests of one file. */
export const test = base.extend<object, { engine: Engine }>({
  engine: [
    // biome-ignore lint/correctness/noEmptyPattern: Playwright reads the fixture's dependencies from this pattern.
    async ({}, use) => {
      const engine = await startEngine();
      await use(engine);
      await engine.stop();
    },
    { scope: "worker" },
  ],
});

export { expect } from "@playwright/test";
