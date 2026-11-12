import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { readRealConfig } from "./real-config.ts";

const base = mkdtempSync(join(tmpdir(), "qx-real-config-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));
const write = (path: string, text: string) => {
  mkdirSync(dirname(join(base, path)), { recursive: true });
  writeFileSync(join(base, path), text);
};
const skill = (description: string) => `---\nname: x\ndescription: ${description}\n---\nBody\n`;

write("home/.claude.json", JSON.stringify({ mcpServers: { "home-server": {} } }));
write("config/.claude.json", JSON.stringify({ mcpServers: { "config-server": {} } }));
write("config/CLAUDE.md", "* A rule that is long enough to be a canary\n");
write("config/skills/own-skill/SKILL.md", skill("My own skill for the house rules"));
write("config/agents/own-agent.md", skill("My own agent"));
write("config/commands/ship.md", "Ship it\n");
write("plugin/skills/plugin-skill/SKILL.md", skill("A skill that a plugin installs"));
write("plugin/agents/plugin-agent.md", "agent\n");
write(
  "config/plugins/installed_plugins.json",
  JSON.stringify({ version: 2, plugins: { "p@m": [{ installPath: join(base, "plugin") }] } }),
);
write("cwd/.claude/skills/project-skill/SKILL.md", skill("A skill of this project"));
write("cwd/.claude/agents/project-agent.md", "agent\n");

describe("readRealConfig", () => {
  const config = readRealConfig({
    configDir: join(base, "config"),
    home: join(base, "home"),
    cwd: join(base, "cwd"),
    extra: [],
  });

  test("reads .claude.json from the home folder and from the config folder", () => {
    expect(config.claudeJsons).toEqual([
      { mcpServers: { "home-server": {} } },
      { mcpServers: { "config-server": {} } },
    ]);
  });

  test("collects skills of the user, of installed plugins and of the project, with descriptions", () => {
    expect(config.skills).toEqual([
      { name: "own-skill", description: "My own skill for the house rules" },
      { name: "plugin-skill", description: "A skill that a plugin installs" },
      { name: "project-skill", description: "A skill of this project" },
    ]);
  });

  test("collects agents the same way, and the user's commands", () => {
    expect(config.agents?.map((a) => a.name)).toEqual(["own-agent", "plugin-agent", "project-agent"]);
    expect(config.commands).toEqual([{ name: "ship" }]);
  });

  test("reads the global instructions and adds the home path to the extra terms", () => {
    expect(config.claudeMd).toContain("long enough");
    expect(config.extra).toEqual([join(base, "home")]);
  });

  test("works on an empty config folder", () => {
    const empty = readRealConfig({ configDir: join(base, "none"), home: join(base, "none"), cwd: base, extra: [] });
    expect(empty).toEqual({ claudeJsons: [], skills: [], agents: [], commands: [], extra: [join(base, "none")] });
  });
});
