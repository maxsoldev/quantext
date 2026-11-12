/**
 * Canary terms: strings from the recording user's real Claude Code config that must never show up in a fixture.
 * A hit means the recording saw the real config, so isolation failed. The terms are read at run time and never
 * stored in the repo.
 */

export interface Named {
  name: string;
  /** The `description` of the frontmatter, if any. */
  description?: string;
}

export interface RealConfig {
  /** Text of the real global instructions (`CLAUDE.md` in the real config folder). */
  claudeMd?: string;
  /** Parsed real `settings.json` (MCP servers, plugins, hooks). */
  settings?: unknown;
  /** Parsed real `.claude.json` files, from the home and the config folder (MCP servers per user and project). */
  claudeJsons?: readonly unknown[];
  skills?: readonly Named[];
  agents?: readonly Named[];
  commands?: readonly Named[];
  /** More terms, for example from `QX_CANARY_TERMS`. */
  extra?: readonly string[];
}

/** Plugins from this marketplace are public; the marketplace name shows up in Claude Code's own text. */
const OFFICIAL_MARKETPLACE = "claude-plugins-official";
/** Names that Claude Code itself uses for built-in skills and agents, so they appear in every recording. */
const BUILT_IN = new Set(
  [
    "dataviz",
    "update-config",
    "keybindings-help",
    "code-review",
    "simplify",
    "fewer-permission-prompts",
    "loop",
    "claude-api",
    "workflow-authoring",
    "run",
    "plugin-authoring",
    "init",
    "security-review",
    "claude",
    "explore",
    "general-purpose",
    "plan",
    "statusline-setup",
    "claude-code-guide",
  ].map((name) => name.toLowerCase()),
);
/** Interpreters and shells in hook commands: ordinary words, not canaries. */
const INTERPRETERS = new Set(["bash", "node", "python", "python3", "zsh", "deno", "bun", "npx", "uvx", "env"]);
const MIN_LINE = 20;
const MIN_TERM = 4;
const MAX_DESCRIPTION = 80;

/** Build the canary terms from the real config. */
export function canaryTerms(config: RealConfig): string[] {
  const terms: string[] = [];
  for (const line of (config.claudeMd ?? "").split("\n")) {
    const text = line.replace(/^\s*(?:[-*+]|#+|\d+\.)\s+/, "").trim();
    if (text.length >= MIN_LINE) terms.push(text);
  }
  for (const claudeJson of (config.claudeJsons ?? []).map(record)) {
    terms.push(...Object.keys(record(claudeJson.mcpServers)));
    for (const project of Object.values(record(claudeJson.projects))) {
      terms.push(...Object.keys(record(record(project).mcpServers)));
    }
  }
  const settings = record(config.settings);
  terms.push(...Object.keys(record(settings.mcpServers)));
  for (const plugin of Object.keys(record(settings.enabledPlugins))) {
    const [name = "", marketplace = ""] = plugin.split("@");
    if (!BUILT_IN.has(name.toLowerCase())) terms.push(name);
    if (marketplace !== OFFICIAL_MARKETPLACE) terms.push(marketplace);
  }
  terms.push(...hookScripts(settings.hooks));
  // A one-word name is often an ordinary word ("research"), so it is looked for in the form that lists it.
  const named = (items: readonly Named[] | undefined, listed: (name: string) => string) => {
    for (const { name, description } of items ?? []) {
      if (name.length >= MIN_TERM && !BUILT_IN.has(name.toLowerCase()))
        terms.push(/[-_\d]/.test(name) ? name : listed(name));
      const text = (description ?? "").split("\n")[0]?.trim().slice(0, MAX_DESCRIPTION) ?? "";
      if (text.length >= MIN_LINE) terms.push(text);
    }
  };
  named(config.skills, (name) => `- ${name}:`);
  named(config.agents, (name) => `- ${name}:`);
  named(config.commands, (name) => `/${name}`);
  terms.push(...(config.extra ?? []));
  return [...new Set(terms.map((t) => t.trim()).filter((t) => t.length >= MIN_TERM))];
}

/** Base names (without extension) of the scripts that hook commands run. */
function hookScripts(hooks: unknown): string[] {
  const commands: string[] = [];
  const walk = (value: unknown) => {
    if (Array.isArray(value)) value.forEach(walk);
    else if (typeof value === "object" && value !== null) {
      const { command } = value as { command?: unknown };
      if (typeof command === "string") commands.push(command);
      Object.values(value).forEach(walk);
    }
  };
  walk(hooks);
  return commands.flatMap((command) =>
    command
      .split(/\s+/)
      .filter((word) => word.includes("/")) // a script path; plain words ("session") are too common
      .map((word) => (word.split("/").at(-1) ?? "").replace(/\.[A-Za-z0-9]+$/, ""))
      .filter((word) => word !== "" && !word.startsWith("-") && !INTERPRETERS.has(word)),
  );
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
