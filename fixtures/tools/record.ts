/**
 * Record the fixture scenarios with the installed `claude`, in an isolated config, then normalise, check for
 * personal data, secrets and canaries, and write fixtures/claude-code/<version>/<scenario>/.
 * Usage: node fixtures/tools/record.ts [--keep] [scenario ...]   (no names: all scenarios)
 *        node fixtures/tools/record.ts --check                   (canary scan of the committed fixtures only)
 * --keep leaves the temp recording root in place for debugging. Costs real API money: see fixtures/README.md.
 */
import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { localDenylist } from "../../scripts/lib/personal-data.ts";
import { canaryTerms } from "./canary.ts";
import { FIXTURE_IDENTITY, writeDummyRepo } from "./dummy-repo.ts";
import { checkClean, childEnv, secretValues } from "./isolation.ts";
import type { CompactionSummary, Manifest, TranscriptSummary } from "./manifest.ts";
import { compactionsOf, summariseTranscript } from "./manifest.ts";
import { normaliseSession, replacementsFor } from "./normalise.ts";
import { readRealConfig } from "./real-config.ts";
import type { Scenario } from "./scenarios.ts";
import { SCENARIOS } from "./scenarios.ts";

const TOOLS = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(TOOLS, "..", "..");
const FIXTURES = join(REPO_ROOT, "fixtures", "claude-code");

const SETTINGS = {
  skipDangerousModePermissionPrompt: true,
  autoUpdates: false,
  // No co-author line in the attribution reminder: it carries an email address.
  attribution: { commit: "", pr: "" },
};

const BASE_ARGS = ["-p", "--output-format", "json", "--permission-mode", "bypassPermissions", "--strict-mcp-config"];

function main(): void {
  const args = process.argv.slice(2);
  const realConfigDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
  const settingsEnv = (readJson(join(realConfigDir, "settings.json")) as { env?: Record<string, string> })?.env ?? {};
  const deny = [
    ...localDenylist({ email: gitEmail(), hostname: hostname() }),
    ...canaryTerms(
      readRealConfig({
        configDir: realConfigDir,
        home: homedir(),
        cwd: process.cwd(),
        extra: (process.env.QX_CANARY_TERMS ?? "").split(","),
      }),
    ),
    ...secretValues({ ...settingsEnv, ...process.env }),
  ];
  if (args.includes("--check")) {
    checkCommitted(deny);
    return;
  }

  const keep = args.includes("--keep");
  const names = args.filter((a) => a !== "--keep");
  const unknown = names.filter((n) => !SCENARIOS.some((s) => s.name === n));
  if (unknown.length > 0) throw new Error(`Unknown scenario(s): ${unknown.join(", ")}`);
  const chosen = SCENARIOS.filter((s) => names.length === 0 || names.includes(s.name));

  const claude = realpathSync(execFileSync("which", ["claude"], { encoding: "utf8" }).trim());
  const version = execFileSync(claude, ["--version"], { encoding: "utf8" }).trim().split(" ")[0] ?? "";
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Unexpected claude --version output: ${version}`);
  console.log(`Claude Code ${version}; ${deny.length} canary and secret terms.`);

  let total = 0;
  for (const scenario of chosen) {
    const root = realpathSync(mkdtempSync("/tmp/qxrec."));
    try {
      const cost = recordScenario(scenario, root, { claude, version, deny, settingsEnv });
      total += cost;
      console.log(`  ${scenario.name}: $${cost.toFixed(4)}`);
    } finally {
      if (keep) console.log(`  kept recording root for ${scenario.name}: ${root}`);
      else rmSync(root, { recursive: true, force: true });
    }
  }
  console.log(`Total recording cost: $${total.toFixed(4)}`);
}

interface Context {
  claude: string;
  version: string;
  deny: string[];
  settingsEnv: Record<string, string>;
}

function recordScenario(scenario: Scenario, root: string, context: Context): number {
  const dirs = { home: "home", config: "config", tmp: "tmp", repo: "repo", bin: "bin", mcp: "mcp" };
  const at = Object.fromEntries(Object.entries(dirs).map(([k, v]) => [k, join(root, v)])) as typeof dirs;
  for (const dir of Object.values(at)) mkdirSync(dir);
  symlinkSync(context.claude, join(at.bin, "claude"));
  symlinkSync(process.execPath, join(at.bin, "node"));
  writeFileSync(join(at.config, "settings.json"), `${JSON.stringify(SETTINGS, null, 2)}\n`);
  writeFileSync(
    join(at.home, ".gitconfig"),
    `[user]\n\tname = ${FIXTURE_IDENTITY.name}\n\temail = ${FIXTURE_IDENTITY.email}\n[init]\n\tdefaultBranch = main\n`,
  );
  const env = childEnv(at, process.env, context.settingsEnv);
  writeDummyRepo(at.repo, env);
  copyFileSync(join(TOOLS, "mcp-server.ts"), join(at.mcp, "server.ts"));
  const mcpConfig = join(at.mcp, "config.json");
  const server = { type: "stdio", command: "node", args: [join(at.mcp, "server.ts")] };
  writeFileSync(mcpConfig, `${JSON.stringify({ mcpServers: { dictionary: server } }, null, 2)}\n`);
  const replacements = replacementsFor(root);
  const placeholder = (text: string) => replacements.reduce((acc, [from, to]) => acc.replaceAll(from, to), text);

  const commands: string[] = [];
  let cost = 0;
  for (const [index, step] of scenario.steps.entries()) {
    const session = index === 0 ? ["--session-id", scenario.sessionId] : ["--resume", scenario.sessionId];
    const extra = [...(scenario.args ?? []), ...(step.args ?? [])].map((a) => a.replace("{mcpConfig}", mcpConfig));
    // Extra flags first: `--mcp-config` takes many values and would swallow the prompt.
    const argv = [...extra, ...BASE_ARGS, ...session, step.prompt];
    const run = spawnSync("claude", argv, { cwd: at.repo, env, encoding: "utf8", timeout: 600_000 });
    const result = parseResult(run.stdout);
    if (run.status !== 0 || result.is_error === true) {
      // stderr and the result text may hold local paths; they stay on this machine's terminal only.
      throw new Error(`${scenario.name} step ${index + 1} failed (exit ${run.status}): ${run.stderr}\n${run.stdout}`);
    }
    cost += typeof result.total_cost_usd === "number" ? result.total_cost_usd : 0;
    commands.push(placeholder(["claude", ...argv.slice(0, -1), JSON.stringify(step.prompt)].join(" ")));
  }

  const { files, unresolvedTailHashes } = normaliseSession(collectTranscripts(at.config), replacements);
  const problems = checkClean(files, root, context.deny);
  if (problems.length > 0) {
    throw new Error(`${scenario.name}: isolation or normalisation failed, nothing written:\n${problems.join("\n")}`);
  }
  if (unresolvedTailHashes > 0) {
    console.warn(`  ${scenario.name}: ${unresolvedTailHashes} tail hash(es) match no message; a new wire form?`);
  }

  const out = join(FIXTURES, context.version, scenario.name);
  rmSync(out, { recursive: true, force: true });
  const transcripts: Record<string, TranscriptSummary> = {};
  const compactions: Record<string, CompactionSummary[]> = {};
  const ordered = Object.keys(files).sort((a, b) => a.split("/").length - b.split("/").length || cmp(a, b));
  for (const path of ordered) {
    const text = files[path] ?? "";
    mkdirSync(dirname(join(out, path)), { recursive: true });
    writeFileSync(join(out, path), text);
    if (!path.endsWith(".jsonl")) continue;
    transcripts[path] = summariseTranscript(path, text);
    const found = compactionsOf(text);
    if (found.length > 0) compactions[path] = found;
  }
  const manifest: Manifest = {
    scenario: scenario.name,
    harness: "claude-code",
    harnessVersion: context.version,
    description: scenario.description,
    exercises: scenario.exercises,
    steps: commands,
    costUsd: Math.round(cost * 10_000) / 10_000,
    unresolvedTailHashes,
    transcripts,
    compactions,
  };
  writeFileSync(join(out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return cost;
}

/** Scan the committed fixtures for canaries and secrets, as a recording is scanned before it is written. */
function checkCommitted(deny: string[]): void {
  const files: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else files[relative(FIXTURES, path)] = readFileSync(path, "utf8");
    }
  };
  if (existsSync(FIXTURES)) walk(FIXTURES);
  const problems = checkClean(files, "/tmp/qxrec.", deny);
  for (const problem of problems) console.error(problem);
  console.log(`Canary check: ${Object.keys(files).length} files, ${deny.length} terms, ${problems.length} hit(s).`);
  if (problems.length > 0) process.exitCode = 1;
}

/** All files under the one project folder of the isolated config, by path relative to it. */
function collectTranscripts(config: string): Record<string, string> {
  const projects = join(config, "projects");
  const folders = existsSync(projects) ? readdirSync(projects) : [];
  if (folders.length !== 1) throw new Error(`Expected one project folder, found ${folders.length}`);
  const base = join(projects, folders[0] ?? "");
  const files: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else files[relative(base, path)] = readFileSync(path, "utf8");
    }
  };
  walk(base);
  return files;
}

function readJson(path: string): unknown {
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined;
}

function gitEmail(): string {
  const result = spawnSync("git", ["config", "user.email"], { cwd: REPO_ROOT, encoding: "utf8" });
  return result.status === 0 ? result.stdout : ""; // exit 1: no email configured
}

function parseResult(stdout: string): Record<string, unknown> {
  try {
    return JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    return { is_error: true }; // not JSON: the caller reports stdout and stderr
  }
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
