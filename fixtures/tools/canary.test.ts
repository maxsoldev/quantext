import { describe, expect, test } from "vitest";
import { canaryTerms } from "./canary.ts";

describe("canaryTerms", () => {
  test("takes the long lines of the real global instructions, without list or heading marks", () => {
    const claudeMd =
      "# Key rules\n* Reply in the house style of Example Corp\n* short\n\n  - Never push to main on Fridays\n";
    expect(canaryTerms({ claudeMd })).toEqual([
      "Reply in the house style of Example Corp",
      "Never push to main on Fridays",
    ]);
  });

  test("takes MCP server names from every .claude.json and project, plugin names, own marketplaces", () => {
    const claudeJsons = [
      { mcpServers: { "team-graph": {} }, projects: { "/x": { mcpServers: { "local-notes": {} } }, "/y": {} } },
      { mcpServers: { "config-dir-server": {} } },
    ];
    const settings = {
      mcpServers: { "work-wiki": {} },
      enabledPlugins: {
        "trace-hooks@acme-tools": true,
        "context7@claude-plugins-official": true,
        "code-review@claude-plugins-official": true,
      },
    };
    expect(canaryTerms({ claudeJsons, settings }).sort()).toEqual(
      ["acme-tools", "config-dir-server", "context7", "local-notes", "team-graph", "trace-hooks", "work-wiki"].sort(),
    );
  });

  test("adds extra terms, drops terms under 4 characters and duplicates", () => {
    expect(canaryTerms({ extra: ["acme", "ab", "acme", " spaced "] })).toEqual(["acme", "spaced"]);
  });

  test("takes skill, agent and command names and descriptions, but not built-in names", () => {
    const terms = canaryTerms({
      skills: [
        { name: "deep-review", description: "Review a branch against the house rules of Acme" },
        { name: "research", description: "short" },
        { name: "code-review" },
        { name: "pr" },
      ],
      agents: [{ name: "triage-bot" }],
      commands: [{ name: "ship" }],
    });
    expect(terms.sort()).toEqual(
      ["- research:", "/ship", "Review a branch against the house rules of Acme", "deep-review", "triage-bot"].sort(),
    );
  });

  test("takes the script names of hook commands, not the interpreters or plain words", () => {
    const settings = {
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: "bash ~/x/send-traces.sh --flag" }] }],
        Stop: [{ hooks: [{ type: "command", command: "node /opt/bin/node session start" }] }],
      },
    };
    expect(canaryTerms({ settings })).toEqual(["send-traces"]);
  });
});
