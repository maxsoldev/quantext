/**
 * Validate the mod and run its tests with Claude Code's own kit (`claude plugin validate`, `claude plugin test`):
 * the tests import `claude-code/testing`, which only that runner provides. Without the `claude` CLI on PATH (CI)
 * this says so loudly and exits 0; set QUANTEXT_REQUIRE_CLAUDE=1 to fail instead.
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const mod = join(import.meta.dirname, "..", "packages", "mod");
const run = (args: string[]) => spawnSync("claude", args, { stdio: "inherit" });

const validate = run(["plugin", "validate", mod]);
if (validate.error !== undefined && (validate.error as NodeJS.ErrnoException).code === "ENOENT") {
  console.error(
    "\n*** mod tests SKIPPED: the claude CLI is not on PATH (packages/mod needs `claude plugin test`) ***\n",
  );
  process.exit(process.env.QUANTEXT_REQUIRE_CLAUDE === "1" ? 1 : 0);
}
if (validate.status !== 0) process.exit(validate.status ?? 1);
process.exit(run(["plugin", "test", mod]).status ?? 1);
