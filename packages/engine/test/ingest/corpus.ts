/**
 * Fixture scenarios laid out as a Claude Code config folder (`<root>/projects/<project>/<session>.jsonl`, subagents
 * under `<session>/subagents/`), and the graph the adapter gives for them in one read, for comparison with ingest.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { SessionDelta, SessionGraph } from "@quantext/shared";
import { createClaudeCodeParser } from "../../src/adapters/claude-code/index.ts";
import { emptyGraph, mergeDelta } from "../../src/core/graph.ts";
import { FIXTURES_DIR } from "../fixtures.ts";
import { normal } from "../store/graph.ts";

export interface LaidOut {
  /** The main transcript in the root. */
  main: string;
  /** The subagent transcripts and meta files in the root, by fixture file name. */
  subagents: { path: string; meta?: string; source: string; sourceMeta?: string }[];
  /** The fixture's main transcript. */
  source: string;
}

/** Where a scenario's files go under `root`, without writing them. */
export function layout(root: string, scenario: string, version = "2.1.322"): LaidOut {
  const dir = join(FIXTURES_DIR, version, scenario);
  const name = readdirSync(dir).find((n) => n.endsWith(".jsonl"));
  if (name === undefined) throw new Error(`no transcript in ${dir}`);
  const project = join(root, "projects", `-fixture-${scenario}`);
  const session = name.replace(/\.jsonl$/, "");
  const agentsDir = join(dir, session, "subagents");
  const subagents = existsSync(agentsDir)
    ? readdirSync(agentsDir)
        .filter((n) => n.endsWith(".jsonl"))
        .sort()
        .map((n) => {
          const path = join(project, session, "subagents", n);
          const sourceMeta = join(agentsDir, n.replace(/\.jsonl$/, ".meta.json"));
          return existsSync(sourceMeta)
            ? { path, source: join(agentsDir, n), meta: path.replace(/\.jsonl$/, ".meta.json"), sourceMeta }
            : { path, source: join(agentsDir, n) };
        })
    : [];
  return { main: join(project, name), subagents, source: join(dir, name) };
}

/** Copy a whole scenario into `root`. */
export function copyScenario(root: string, scenario: string): LaidOut {
  const files = layout(root, scenario);
  mkdirSync(join(files.main, ".."), { recursive: true });
  copyFileSync(files.source, files.main);
  for (const agent of files.subagents) {
    mkdirSync(join(agent.path, ".."), { recursive: true });
    copyFileSync(agent.source, agent.path);
    if (agent.meta !== undefined && agent.sourceMeta !== undefined) copyFileSync(agent.sourceMeta, agent.meta);
  }
  return files;
}

/** Write text to a file, creating its folder. */
export function writeText(path: string, text: string | Buffer): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
}

/**
 * The adapter's graph for these transcripts in one read, with the transcript names ingest gives: `main`, and the
 * file name (without `.jsonl`) of each subagent. Text after the last newline is held back, as ingest does.
 */
export function expectedGraph(main: Buffer | string, subagents: { name: string; text: string; meta?: string }[] = []) {
  const parser = createClaudeCodeParser();
  const deltas: SessionDelta[] = [parser.push(complete(String(main)))];
  for (const agent of subagents) {
    if (agent.meta !== undefined) deltas.push(parser.pushMeta(agent.name, agent.meta));
    deltas.push(parser.push(complete(agent.text), agent.name));
  }
  return normal(deltas.reduce(mergeDelta, emptyGraph()));
}

/** The expected graph of a whole scenario as laid out by `layout`. */
export function expectedScenario(files: LaidOut): SessionGraph {
  return expectedGraph(
    readFileSync(files.source),
    files.subagents.map((a) => {
      const agent = { name: basename(a.path).replace(/\.jsonl$/, ""), text: readFileSync(a.source, "utf8") };
      return a.sourceMeta === undefined ? agent : { ...agent, meta: readFileSync(a.sourceMeta, "utf8") };
    }),
  );
}

function complete(text: string): string {
  return text.slice(0, text.lastIndexOf("\n") + 1);
}
