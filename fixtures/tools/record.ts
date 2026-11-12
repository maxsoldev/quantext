/**
 * Record the fixture scenarios with the installed `claude`, in an isolated config, then normalise, check for
 * personal data and canaries, and write fixtures/claude-code/<version>/<scenario>/.
 * Usage: node fixtures/tools/record.ts [--keep] [scenario ...]   (no names: all scenarios)
 * --keep leaves the temp recording root in place for inspection. Costs real API money: see fixtures/README.md.
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
import { localDenylist, scanText } from "../../scripts/lib/personal-data.ts";
import { canaryTerms } from "./canary.ts";
import { FIXTURE_IDENTITY, writeDummyRepo } from "./dummy-repo.ts";
import type { Manifest, TranscriptSummary } from "./manifest.ts";
import { summariseTranscript } from "./manifest.ts";
import type { Replacement } from "./normalise.ts";
import { normaliseSession } from "./normalise.ts";
import type { Scenario } from "./scenarios.ts";
import { SCENARIOS } from "./scenarios.ts";

const TOOLS = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(TOOLS, "..", "..");
const PLACEHOLDER_ROOT = "/fixture";

/** Passed through from the caller's environment (or the `env` of the real settings), nothing else. */
const AUTH_VARS = [
  "CLAUDE_CODE_USE_BEDROCK",
  "AWS_REGION",
  "AWS_BEARER_TOKEN_BEDROCK",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
] as const;

const SETTINGS = {
  skipDangerousModePermissionPrompt: true,
  autoUpdates: false,
  // No co-author line in the attribution reminder: it carries an email address.
  attribution: { commit: "", pr: "" },
};

const BASE_ARGS = ["-p", "--output-format", "json", "--permission-mode", "bypassPermissions", "--strict-mcp-config"];

function main(): void {
  const args = process.argv.slice(2);
  const keep = args.includes("--keep");
  const names = args.filter((a) => a !== "--keep");
  const unknown = names.filter((n) => !SCENARIOS.some((s) => s.name === n));
  if (unknown.length > 0) throw new Error(`Unknown scenario(s): ${unknown.join(", ")}`);
  const chosen = SCENARIOS.filter((s) => names.length === 0 || names.includes(s.name));

  const claude = realpathSync(execFileSync("which", ["claude"], { encoding: "utf8" }).trim());
  const version = execFileSync(claude, ["--version"], { encoding: "utf8" }).trim().split(" ")[0] ?? "";
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Unexpected claude --version output: ${version}`);
  const deny = [...localDenylist({ email: gitEmail(), hostname: hostname() }), ...canaryTerms(readRealConfig())];
  console.log(`Claude Code ${version}; ${deny.length} canary terms.`);

  let total = 0;
  for (const scenario of chosen) {
    const cost = recordScenario(scenario, { claude, version, deny, keep });
    total += cost;
    console.log(`  ${scenario.name}: $${cost.toFixed(4)}`);
  }
  console.log(`Total recording cost: $${total.toFixed(4)}`);
}

interface Context {
  claude: string;
  version: string;
  deny: string[];
  keep: boolean;
}

function recordScenario(scenario: Scenario, context: Context): number {
  const root = realpathSync(mkdtempSync("/tmp/qxrec."));
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
  const env = childEnv(at);
  writeDummyRepo(at.repo, env);
  copyFileSync(join(TOOLS, "mcp-server.ts"), join(at.mcp, "server.ts"));
  const mcpConfig = join(at.mcp, "config.json");
  const server = { type: "stdio", command: "node", args: [join(at.mcp, "server.ts")] };
  writeFileSync(mcpConfig, `${JSON.stringify({ mcpServers: { dictionary: server } }, null, 2)}\n`);

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
    commands.push(
      ["claude", ...argv.slice(0, -1), JSON.stringify(step.prompt)].join(" ").replaceAll(root, PLACEHOLDER_ROOT),
    );
  }

  const files = collectTranscripts(at.config);
  const { files: normalised, unresolvedTailHashes } = normaliseSession(files, replacementsFor(root));
  checkClean(scenario.name, normalised, root, context.deny);
  if (unresolvedTailHashes > 0) {
    console.warn(`  ${scenario.name}: ${unresolvedTailHashes} tail hash(es) match no message; a new wire form?`);
  }

  const out = join(REPO_ROOT, "fixtures", "claude-code", context.version, scenario.name);
  rmSync(out, { recursive: true, force: true });
  const transcripts: Record<string, TranscriptSummary> = {};
  const ordered = Object.keys(normalised).sort((a, b) => a.split("/").length - b.split("/").length || cmp(a, b));
  for (const path of ordered) {
    mkdirSync(dirname(join(out, path)), { recursive: true });
    writeFileSync(join(out, path), normalised[path] ?? "");
    if (path.endsWith(".jsonl")) transcripts[path] = summariseTranscript(path, normalised[path] ?? "");
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
  };
  writeFileSync(join(out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  if (context.keep) console.log(`  kept recording root for ${scenario.name}: ${root}`);
  else rmSync(root, { recursive: true, force: true });
  return cost;
}

/** An empty environment plus an allowlist: no session-coupling or other variables of the caller leak in. */
function childEnv(at: { home: string; config: string; tmp: string; bin: string }): NodeJS.ProcessEnv {
  const realEnv = readJson(join(homedir(), ".claude", "settings.json")) as { env?: Record<string, string> } | undefined;
  const env: NodeJS.ProcessEnv = {
    PATH: `${at.bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
    HOME: at.home,
    TMPDIR: at.tmp,
    CLAUDE_CONFIG_DIR: at.config,
    LANG: "en_US.UTF-8",
    GIT_CONFIG_NOSYSTEM: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_AUTOUPDATER: "1",
  };
  for (const name of AUTH_VARS) {
    const value = process.env[name] ?? realEnv?.env?.[name];
    if (value !== undefined && value !== "") env[name] = value;
  }
  if (env.CLAUDE_CODE_USE_BEDROCK === undefined && env.ANTHROPIC_API_KEY === undefined) {
    throw new Error("No auth: set CLAUDE_CODE_USE_BEDROCK (+ AWS vars) or ANTHROPIC_API_KEY.");
  }
  return env;
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

/** The recording root as Claude Code may write it: resolved, through the `/tmp` link, and dash-encoded. */
export function replacementsFor(root: string): Replacement[] {
  const encode = (path: string) => path.replace(/[^A-Za-z0-9]/g, "-");
  const forms = [root, root.replace(/^\/private\//, "/")];
  return [
    ...forms.map((form) => [form, PLACEHOLDER_ROOT] as const),
    ...forms.map((form) => [encode(form), encode(PLACEHOLDER_ROOT)] as const),
  ];
}

/** Fail, and write nothing, when a file still names the recording root, or holds personal data or a canary. */
function checkClean(scenario: string, files: Record<string, string>, root: string, deny: string[]): void {
  const leftover = root.split("/").at(-1) ?? root;
  const problems: string[] = [];
  for (const [path, text] of Object.entries(files)) {
    for (const f of scanText(`${path}\n${text}`, { deny })) problems.push(`${path}:${f.line - 1}  ${f.kind}`);
    if (text.includes(leftover) || path.includes(leftover)) problems.push(`${path}  recording root left over`);
  }
  if (problems.length > 0) {
    throw new Error(`${scenario}: isolation or normalisation failed, nothing written:\n${problems.join("\n")}`);
  }
}

function readRealConfig() {
  const home = homedir();
  const claudeMd = existsSync(join(home, ".claude", "CLAUDE.md"))
    ? readFileSync(join(home, ".claude", "CLAUDE.md"), "utf8")
    : undefined;
  const extra = (process.env.QX_CANARY_TERMS ?? "").split(",");
  return {
    ...(claudeMd === undefined ? {} : { claudeMd }),
    settings: readJson(join(home, ".claude", "settings.json")),
    claudeJson: readJson(join(home, ".claude.json")),
    extra: [...extra, home],
  };
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
