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

  test("takes MCP server names from the user config and every project, and plugins from own marketplaces", () => {
    const claudeJson = {
      mcpServers: { "team-graph": {} },
      projects: { "/x": { mcpServers: { "local-notes": {} } }, "/y": {} },
    };
    const settings = {
      mcpServers: { "work-wiki": {} },
      enabledPlugins: { "trace-hooks@acme-tools": true, "context7@claude-plugins-official": true },
    };
    expect(canaryTerms({ claudeJson, settings }).sort()).toEqual(
      ["acme-tools", "local-notes", "team-graph", "trace-hooks", "work-wiki"].sort(),
    );
  });

  test("adds extra terms, drops terms under 4 characters and duplicates", () => {
    expect(canaryTerms({ extra: ["acme", "ab", "acme", " spaced "] })).toEqual(["acme", "spaced"]);
  });
});
