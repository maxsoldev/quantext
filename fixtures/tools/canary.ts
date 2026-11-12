/**
 * Canary terms: strings from the recording user's real Claude Code config that must never show up in a fixture.
 * A hit means the recording saw the real config, so isolation failed. The terms are read at run time and never
 * stored in the repo.
 */

export interface RealConfig {
  /** Text of the real global instructions (`~/.claude/CLAUDE.md`). */
  claudeMd?: string;
  /** Parsed real `settings.json`. */
  settings?: unknown;
  /** Parsed real `.claude.json` (MCP servers per user and per project). */
  claudeJson?: unknown;
  /** More terms, for example from `QX_CANARY_TERMS`. */
  extra?: readonly string[];
}

/** Plugins from this marketplace are public; their names show up in Claude Code's own text. */
const OFFICIAL_MARKETPLACE = "claude-plugins-official";
const MIN_LINE = 20;
const MIN_TERM = 4;

/** Build the canary terms from the real config. */
export function canaryTerms(config: RealConfig): string[] {
  const terms: string[] = [];
  for (const line of (config.claudeMd ?? "").split("\n")) {
    const text = line.replace(/^\s*(?:[-*+]|#+|\d+\.)\s+/, "").trim();
    if (text.length >= MIN_LINE) terms.push(text);
  }
  const claudeJson = record(config.claudeJson);
  terms.push(...Object.keys(record(claudeJson.mcpServers)));
  for (const project of Object.values(record(claudeJson.projects))) {
    terms.push(...Object.keys(record(record(project).mcpServers)));
  }
  const settings = record(config.settings);
  terms.push(...Object.keys(record(settings.mcpServers)));
  for (const plugin of Object.keys(record(settings.enabledPlugins))) {
    const [name = "", marketplace = ""] = plugin.split("@");
    if (marketplace !== OFFICIAL_MARKETPLACE) terms.push(name, marketplace);
  }
  terms.push(...(config.extra ?? []));
  return [...new Set(terms.map((t) => t.trim()).filter((t) => t.length >= MIN_TERM))];
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
