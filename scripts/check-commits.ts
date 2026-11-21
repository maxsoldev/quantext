/**
 * Check commit messages against Conventional Commits (ADR 31).
 * `check-commits.ts <base>..<head>`: every commit in the range but merges (CI, on a pull request).
 * A commit whose author is a GitHub bot (`…[bot]@users.noreply.github.com`) may have a longer subject.
 * `check-commits.ts --file <path>`: one message file (the `.githooks/commit-msg` hook).
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { checkCommitMessage } from "./lib/commit-message.ts";

const [first = "", second] = process.argv.slice(2);
let messages: { name: string; text: string; bot?: boolean }[];
if (first === "--file" && second) {
  messages = [{ name: second, text: readFileSync(second, "utf8") }];
} else if (first.includes("..") && second === undefined) {
  const log = execFileSync("git", ["log", "--no-merges", "--format=%h %s%x00%ae%x00%B%x1e", first], {
    encoding: "utf8",
  });
  messages = log
    .split("\x1e")
    .filter((entry) => entry.trim() !== "")
    .map((entry) => {
      const [name = "", email = "", text = ""] = entry.trim().split("\0");
      return { name, text, bot: email.endsWith("[bot]@users.noreply.github.com") };
    });
} else {
  console.error("usage: check-commits.ts <base>..<head> | --file <path>");
  process.exit(2);
}

let bad = 0;
for (const { name, text, bot } of messages) {
  const problems = checkCommitMessage(text, { bot });
  if (problems.length === 0) continue;
  bad++;
  console.error(`${name}\n${problems.map((p) => `  - ${p}`).join("\n")}`);
}
if (bad > 0) {
  console.error(`\n${bad} of ${messages.length} commit message(s) do not follow Conventional Commits (AGENTS.md).`);
  process.exit(1);
}
console.log(`${messages.length} commit message(s) follow Conventional Commits`);
