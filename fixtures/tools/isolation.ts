/** What the recorded `claude` may see of this machine (its environment), and the check of what it wrote. */
import { scanText } from "../../scripts/lib/personal-data.ts";

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

/** Secrets whose values must never show up in a recording. */
const SECRET_VARS = ["AWS_BEARER_TOKEN_BEDROCK", "ANTHROPIC_API_KEY", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"];

type Env = Record<string, string | undefined>;

/**
 * The child's whole environment: fixed variables, the root's folders, and the auth variables (from the caller, else
 * from the real settings `env`). Nothing else passes, so session-coupling variables of a calling Claude Code
 * (`CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_MESSAGING_*`, …) and personal ones cannot leak in.
 */
export function childEnv(
  at: { home: string; config: string; tmp: string; bin: string },
  processEnv: Env,
  settingsEnv: Env,
): Record<string, string> {
  const env: Record<string, string> = {
    PATH: `${at.bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
    HOME: at.home,
    TMPDIR: at.tmp,
    CLAUDE_CONFIG_DIR: at.config,
    LANG: "en_US.UTF-8",
    TZ: "UTC",
    GIT_CONFIG_NOSYSTEM: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_AUTOUPDATER: "1",
  };
  for (const name of AUTH_VARS) {
    const value = processEnv[name] || settingsEnv[name];
    if (value) env[name] = value;
  }
  if (env.CLAUDE_CODE_USE_BEDROCK === undefined && env.ANTHROPIC_API_KEY === undefined) {
    throw new Error("No auth: set CLAUDE_CODE_USE_BEDROCK (+ AWS vars) or ANTHROPIC_API_KEY.");
  }
  return env;
}

/** The set values of the secret variables, to scan the recording for as exact matches. */
export function secretValues(env: Env): string[] {
  return SECRET_VARS.map((name) => env[name] ?? "").filter((value) => value !== "");
}

/**
 * Problems that forbid writing a recording: the recording root left over, personal data, or a denied term
 * (canaries, secret values). Each problem names the file and line and the rule, never the matched value.
 */
export function checkClean(files: Record<string, string>, root: string, deny: readonly string[]): string[] {
  const leftover = root.split("/").at(-1) ?? root;
  const problems: string[] = [];
  for (const [path, text] of Object.entries(files)) {
    if (path.includes(leftover)) problems.push(`${path}  recording root left over`);
    for (const f of scanText(path, { deny })) problems.push(`${path}  (path) ${f.kind}`);
    for (const [index, line] of text.split("\n").entries()) {
      if (line.includes(leftover)) problems.push(`${path}:${index + 1}  recording root left over`);
    }
    for (const f of scanText(text, { deny })) problems.push(`${path}:${f.line}  ${f.kind}`);
  }
  return problems;
}
