/**
 * Steps of the release workflow (`.github/workflows/release.yml`, ADR 30), with the version from the root
 * package.json. `release.ts check-tag <tag>`: fail unless the tag is `v<version>`.
 * `release.ts commit-plugin <dir> <parent ref> <source sha>`: commit the built plugin folder as the next
 * `plugin` branch commit and print its sha (nothing is pushed).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checkReleaseTag, commitPluginTree } from "./lib/release.ts";

const repo = join(import.meta.dirname, "..");
const { version } = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")) as { version: string };
const [command, ...args] = process.argv.slice(2);

if (command === "check-tag" && args.length === 1) {
  checkReleaseTag(args[0] ?? "", version);
  console.log(`tag ${args[0]} matches version ${version}`);
} else if (command === "commit-plugin" && args.length === 3) {
  const [tree = "", parentRef = "", source = ""] = args;
  console.log(commitPluginTree({ repo, tree, version, parentRef, source }));
} else {
  console.error("usage: release.ts check-tag <tag> | commit-plugin <dir> <parent ref> <source sha>");
  process.exit(2);
}
