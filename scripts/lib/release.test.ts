import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { checkReleaseTag, commitPluginTree } from "./release.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "qx-release-"));
  dirs.push(dir);
  return dir;
};
const IDENTITY = {
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.invalid",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.invalid",
};
const git = (repo: string, ...args: string[]) =>
  execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", env: { ...process.env, ...IDENTITY } }).trim();

/** A repo with one source commit, and a built plugin folder outside it. */
function setup(version = "0.1.0") {
  const repo = temp();
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "README.md"), "source\n");
  writeFileSync(join(repo, ".gitignore"), "*.log\nengine/\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "source");
  const plugin = join(temp(), "plugin");
  mkdirSync(join(plugin, ".claude-plugin"), { recursive: true });
  mkdirSync(join(plugin, "engine"));
  writeFileSync(join(plugin, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "quantext", version }));
  writeFileSync(join(plugin, "engine", "engine.js"), "#!/usr/bin/env node\n");
  chmodSync(join(plugin, "engine", "engine.js"), 0o755);
  writeFileSync(join(plugin, "engine", "notes.log"), "kept although a .gitignore names it\n");
  return { repo, plugin };
}

const commit = (repo: string, plugin: string, version = "0.1.0") =>
  commitPluginTree({ repo, tree: plugin, version, parentRef: "refs/heads/plugin", source: "abc1234", env: IDENTITY });

describe("commitPluginTree", () => {
  test("commits exactly the built folder at the root, with modes, ignore rules not applied", () => {
    const { repo, plugin } = setup();
    const sha = commit(repo, plugin);
    expect(git(repo, "ls-tree", "-r", "--format=%(objectmode) %(path)", sha).split("\n")).toEqual([
      "100644 .claude-plugin/plugin.json",
      "100755 engine/engine.js",
      "100644 engine/notes.log",
    ]);
    expect(git(repo, "log", "--format=%s%n%b", sha)).toBe(
      "quantext 0.1.0\nBuilt from abc1234 by the release workflow.",
    );
    expect(git(repo, "rev-list", "--count", sha)).toBe("1"); // no history of main
    expect(git(repo, "status", "--porcelain")).toBe(""); // the repo's own index and work tree are untouched
  });

  test("a later release goes on from the branch tip, so a push is a fast-forward", () => {
    const { repo, plugin } = setup();
    const first = commit(repo, plugin);
    git(repo, "update-ref", "refs/heads/plugin", first);
    writeFileSync(
      join(plugin, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "quantext", version: "0.2.0" }),
    );
    const second = commit(repo, plugin, "0.2.0");
    expect(git(repo, "rev-parse", `${second}^`)).toBe(first);
  });

  test("refuses a folder that is not the plugin of this version", () => {
    const { repo, plugin } = setup("0.0.9");
    expect(() => commit(repo, plugin)).toThrow("plugin.json has version 0.0.9, not 0.1.0");
    expect(() => commit(repo, join(plugin, "engine"))).toThrow(/no \.claude-plugin\/plugin\.json/);
  });

  test("refuses to publish the same tree twice", () => {
    const { repo, plugin } = setup();
    git(repo, "update-ref", "refs/heads/plugin", commit(repo, plugin));
    expect(() => commit(repo, plugin)).toThrow("the plugin branch already holds this tree");
  });
});

describe("checkReleaseTag", () => {
  test("the tag is v and the root package.json's version", () => {
    expect(() => checkReleaseTag("v0.1.0", "0.1.0")).not.toThrow();
    expect(() => checkReleaseTag("v0.1.1", "0.1.0")).toThrow("tag v0.1.1 does not match the version 0.1.0");
    expect(() => checkReleaseTag("0.1.0", "0.1.0")).toThrow(/does not match/);
    expect(() => checkReleaseTag("vx", "x")).toThrow("version x is not semver");
  });
});
