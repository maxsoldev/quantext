/**
 * A bundled engine over a temp copy of the fixtures, one per test file: each scenario is a project folder, as
 * after-step-7.md shows. `append` writes lines to a copied transcript, as a live session does.
 */
import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { Page } from "@playwright/test";
import { test as base } from "@playwright/test";

const repo = join(import.meta.dirname, "..");
const ENGINE = join(repo, "packages", "engine", "dist", "engine.js");
const FIXTURES = join(repo, "fixtures", "claude-code", "2.1.322");

export interface Engine {
  url: string;
  /** The viewer's URL of a scenario's main Session. */
  sessionUrl(scenario: string): Promise<string>;
  /** The transcript of a scenario's main Session in the temp root. */
  transcript(scenario: string): string;
  /** Write a memory file into a scenario's project folder, as the harness does. */
  writeMemory(scenario: string, name: string, content: string): void;
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
  const url = `http://127.0.0.1:${port}`;
  // The engine listens before it has read the logs: wait for the catch-up, so every test starts from all of them.
  await waitLive(url);
  return {
    url,
    async sessionUrl(scenario) {
      const id = basename(mainTranscript(join(FIXTURES, scenario)), ".jsonl");
      const body = (await (await fetch(`${url}/api/v1/session-keys?id=${id}`)).json()) as { items: { log: number }[] };
      const key = body.items[0];
      if (!key) throw new Error(`no Session ${id}`);
      return `${url}/s/${key.log}/${id}`;
    },
    transcript: (s) => mainTranscript(join(root, "projects", `-fixture-${s}`)),
    writeMemory(s, name, content) {
      const dir = join(root, "projects", `-fixture-${s}`, "memory");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, name), content);
    },
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

async function waitLive(url: string): Promise<void> {
  const end = Date.now() + 15_000;
  for (;;) {
    const status = (await (await fetch(`${url}/api/v1/status`)).json()) as { ingest: { phase: string } };
    if (status.ingest.phase === "live") return;
    if (Date.now() > end) throw new Error("the engine did not finish its catch-up");
    await new Promise((r) => setTimeout(r, 50));
  }
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

/**
 * A test with an engine over all the fixtures, shared by the tests of one file. Every page of the test must log
 * no error: a CSP violation (an inline style or script) shows up as one.
 */
export const test = base.extend<{ cleanConsole: undefined }, { engine: Engine }>({
  cleanConsole: [
    async ({ context }, use) => {
      const errors: string[] = [];
      const watch = (page: Page) => {
        page.on("console", (m) => {
          if (m.type() === "error") errors.push(m.text());
        });
        page.on("pageerror", (e) => errors.push(e.message));
      };
      for (const p of context.pages()) watch(p);
      context.on("page", watch);
      await use(undefined);
      if (errors.length > 0) throw new Error(`the page logged errors:\n${errors.join("\n")}`);
    },
    { auto: true },
  ],
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
