/** Read the parts of the recording user's real Claude Code config that canary terms come from. Read only. */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { Named, RealConfig } from "./canary.ts";

export interface Where {
  /** The real config folder: `$CLAUDE_CONFIG_DIR` or `~/.claude`. */
  configDir: string;
  home: string;
  /** The working directory, for project-level `.claude/skills` and `.claude/agents`. */
  cwd: string;
  /** More terms, for example from `QX_CANARY_TERMS`. */
  extra: readonly string[];
}

/**
 * Global instructions, settings, every `.claude.json` (home and config folder), and the skills and agents of the
 * user, of installed plugins (`plugins/installed_plugins.json`) and of the project, plus the user's commands.
 */
export function readRealConfig(where: Where): RealConfig {
  const { configDir, home, cwd } = where;
  const pluginRoots = installPaths(readJson(join(configDir, "plugins", "installed_plugins.json")));
  const roots = [configDir, ...pluginRoots, join(cwd, ".claude")];
  const claudeMd = text(join(configDir, "CLAUDE.md"));
  const settings = readJson(join(configDir, "settings.json"));
  const claudeJsons = [join(home, ".claude.json"), join(configDir, ".claude.json")]
    .filter((path, index, all) => all.indexOf(path) === index)
    .map(readJson)
    .filter((value) => value !== undefined);
  return {
    ...(claudeMd === undefined ? {} : { claudeMd }),
    ...(settings === undefined ? {} : { settings }),
    claudeJsons,
    skills: roots.flatMap((root) => named(join(root, "skills"), (entry) => join(entry, "SKILL.md"))),
    agents: roots.flatMap((root) => named(join(root, "agents"), (entry) => entry)),
    commands: named(join(configDir, "commands"), (entry) => entry),
    extra: [...where.extra, home],
  };
}

function installPaths(installed: unknown): string[] {
  const plugins = (installed as { plugins?: Record<string, { installPath?: unknown }[]> } | undefined)?.plugins;
  return Object.values(plugins ?? {})
    .flat()
    .map((entry) => entry.installPath)
    .filter((path): path is string => typeof path === "string");
}

/** The entries of a skills, agents or commands folder, by name, with the `description` of their frontmatter. */
function named(folder: string, file: (entry: string) => string): Named[] {
  if (!existsSync(folder) || !statSync(folder).isDirectory()) return [];
  return readdirSync(folder)
    .sort()
    .map((entry) => {
      const name = basename(entry, ".md");
      const description = /^description:\s*(.+)$/m.exec(text(join(folder, file(entry))) ?? "")?.[1]?.trim();
      return description === undefined ? { name } : { name, description };
    });
}

function text(path: string): string | undefined {
  return existsSync(path) && statSync(path).isFile() ? readFileSync(path, "utf8") : undefined;
}

function readJson(path: string): unknown {
  const content = text(path);
  return content === undefined ? undefined : JSON.parse(content);
}
