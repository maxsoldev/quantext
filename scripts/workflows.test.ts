/** Supply-chain rules for the GitHub workflows (ADR 28, 30): pinned actions, least permissions. */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const dir = join(import.meta.dirname, "..", ".github", "workflows");
const workflows = readdirSync(dir)
  .filter((name) => name.endsWith(".yml"))
  .map((name) => ({ name, text: readFileSync(join(dir, name), "utf8") }));

describe("workflows", () => {
  test("every action is pinned by a full commit SHA, with its version in a comment", () => {
    const uses = workflows.flatMap(({ name, text }) =>
      [...text.matchAll(/^\s*(?:-\s+)?uses:\s*(\S+)(.*)$/gm)].map((m) => ({ name, action: m[1], rest: m[2] })),
    );
    expect(uses.length).toBeGreaterThan(0);
    for (const { name, action, rest } of uses) {
      expect(action, name).toMatch(/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/);
      expect(rest, `${name} ${action}`).toMatch(/^ # v\d/);
    }
  });

  test("only the release's publish job may write contents; each workflow's default is read or none", () => {
    for (const { name, text } of workflows) expect(text, name).toMatch(/^permissions:(?: \{\}|\n {2}contents: read)$/m);
    const writers = workflows.filter(({ text }) => /contents: write/.test(text)).map(({ name }) => name);
    expect(writers).toEqual(["release.yml"]);
    const release = workflows.find(({ name }) => name === "release.yml")?.text ?? "";
    expect(release.match(/contents: write/g)).toHaveLength(1);
    expect(release.slice(release.indexOf("\n  publish:"))).toContain("contents: write");
    expect(release).not.toMatch(/secrets\./); // only GITHUB_TOKEN
  });
});
