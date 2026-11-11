/**
 * Fail when a file in the repo, or its path, contains personal data (see lib/personal-data.ts).
 * Usage: scan-personal-data.ts [repo root]. Scans tracked and untracked files that git does not ignore.
 * Also looks for this machine's user name, git email and host name; these are read at run time, never stored.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import { join } from "node:path";
import type { Finding } from "./lib/personal-data.ts";
import { localDenylist, scanText } from "./lib/personal-data.ts";

const root = process.argv[2] ?? process.cwd();
const listing = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
  cwd: root,
  encoding: "utf8",
});
const gitEmail = () => {
  const result = spawnSync("git", ["config", "user.email"], { cwd: root, encoding: "utf8" });
  return result.status === 0 ? result.stdout : ""; // exit 1: no email configured
};
const deny = localDenylist({ user: process.env.USER ?? userInfo().username, email: gitEmail(), hostname: hostname() });

const paths = listing.split("\0").filter((path) => path !== "" && existsSync(join(root, path)));

/** Print where and which rule, never the matched value, so the output does not leak what it found. */
const report = (where: string, finding: Finding) => console.error(`${where}  ${finding.kind}`);

let count = 0;
for (const path of paths) {
  for (const finding of scanText(path, { deny })) {
    report(`${path}  (path)`, finding);
    count++;
  }
  const bytes = readFileSync(join(root, path));
  if (bytes.includes(0)) continue; // binary file
  for (const finding of scanText(bytes.toString("utf8"), { deny })) {
    report(`${path}:${finding.line}`, finding);
    count++;
  }
}

if (count > 0) {
  console.error(`\nPersonal-data scan failed: ${count} finding(s). Replace them with placeholders.`);
  process.exit(1);
}
console.log(`Personal-data scan passed: ${paths.length} files, ${deny.length} local identity terms.`);
