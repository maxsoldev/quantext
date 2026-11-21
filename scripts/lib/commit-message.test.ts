import { describe, expect, test } from "vitest";
import { checkCommitMessage } from "./commit-message.ts";

describe("checkCommitMessage", () => {
  test.each([
    "fix: name the reason when the mod says the cache broke",
    "feat(viewer): show the unlogged estimate beside the session cost",
    "feat!: drop the v0 API",
    "build(deps): bump vite from 7.1.0 to 7.1.1",
    "chore(main): release 0.2.0",
    "fix: end a stuck engine\n\nThe old exit left the port bound.\n",
    "fix: read only regular files\n# a git comment line\n",
  ])("accepts %j", (message) => {
    expect(checkCommitMessage(message)).toEqual([]);
  });

  test.each([
    ["Name the reason when the mod says the cache broke", /type/],
    ["fixes: wrong type", /type/],
    ["fix:no space", /type/],
    ["fix(Viewer): upper-case scope", /type/],
    ["fix: ends with a period.", /period/],
    [`fix: ${"x".repeat(70)}`, /72/],
    ["fix: subject\nbody without a blank line", /blank/],
    ["", /empty/],
  ])("rejects %j", (message, reason) => {
    const problems = checkCommitMessage(message);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join("\n")).toMatch(reason);
  });

  test("a bot's subject may be longer than 72, but still needs a type", () => {
    const long = "build(deps-dev): bump the development group across 1 directory with 4 updates";
    expect(checkCommitMessage(long, { bot: true })).toEqual([]);
    expect(checkCommitMessage(long)).not.toEqual([]);
    expect(checkCommitMessage("Bump vite from 7.1.0 to 7.1.1", { bot: true }).join("\n")).toMatch(/type/);
  });
});
