import { join } from "node:path";
import { expect, test } from "vitest";
import { claudeConfigDir } from "../../src/ingest/index.ts";
import { defaultDataDir } from "../../src/store/index.ts";

test("the Claude Code config folder is CLAUDE_CONFIG_DIR when set, else ~/.claude", () => {
  expect(claudeConfigDir({ CLAUDE_CONFIG_DIR: "/cfg" }, "/h")).toBe("/cfg");
  expect(claudeConfigDir({}, "/h")).toBe(join("/h", ".claude"));
  expect(claudeConfigDir({ CLAUDE_CONFIG_DIR: "" }, "/h")).toBe(join("/h", ".claude"));
});

test("the data folder is ~/.quantext", () => {
  expect(defaultDataDir("/h")).toBe(join("/h", ".quantext"));
});
