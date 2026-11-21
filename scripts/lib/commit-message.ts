/** Commit messages follow Conventional Commits, so release-please can pick the next version (ADR 31). */

export const COMMIT_TYPES = ["feat", "fix", "perf", "refactor", "docs", "test", "build", "ci", "chore", "revert"];

const HEADER = new RegExp(`^(?:${COMMIT_TYPES.join("|")})(?:\\([a-z0-9-]+\\))?!?: \\S`);

/**
 * The problems with one commit message, empty when it is fine. Lines that start with `#` are git's
 * comments and do not count. Checks the subject (type, optional scope, `!`, at most 72 characters, no
 * final period) and the blank line after it; the body is free text. A bot (Dependabot) writes its own
 * subjects, often longer than 72, so for a bot the length is not checked.
 */
export function checkCommitMessage(message: string, { bot = false } = {}): string[] {
  const lines = message.split("\n").filter((line) => !line.startsWith("#"));
  const subject = lines[0]?.trim() ?? "";
  if (subject === "") return ["the message is empty"];
  const problems: string[] = [];
  if (!HEADER.test(subject))
    problems.push(
      `the subject must start with "<type>: " or "<type>(<scope>): ", type one of ${COMMIT_TYPES.join(", ")}`,
    );
  if (!bot && subject.length > 72) problems.push(`the subject has ${subject.length} characters, at most 72`);
  if (subject.endsWith(".")) problems.push("the subject ends with a period");
  if ((lines[1] ?? "").trim() !== "") problems.push("the second line must be blank");
  return problems;
}
