/**
 * Fail when a file in the repo, or its path, contains personal data (see lib/personal-data.ts).
 * Usage: scan-personal-data.ts [repo root]. Scans tracked and untracked files that git does not ignore.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Finding } from "./lib/personal-data.ts";
import { scanText } from "./lib/personal-data.ts";

const root = process.argv[2] ?? process.cwd();
const listing = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
  cwd: root,
  encoding: "utf8",
});
const paths = listing.split("\0").filter((path) => path !== "" && existsSync(join(root, path)));

/** Show only the start of a match, so the scan output does not leak what it found. */
const redact = (match: string) => `${match.slice(0, 4)}…`;
const report = (where: string, finding: Finding) =>
  console.error(`${where}  ${finding.kind}  ${redact(finding.match)}`);

let count = 0;
for (const path of paths) {
  for (const finding of scanText(path)) {
    report(`${path}  (path)`, finding);
    count++;
  }
  const bytes = readFileSync(join(root, path));
  if (bytes.includes(0)) continue; // binary file
  for (const finding of scanText(bytes.toString("utf8"))) {
    report(`${path}:${finding.line}`, finding);
    count++;
  }
}

if (count > 0) {
  console.error(`\nPersonal-data scan failed: ${count} finding(s). Replace them with placeholders.`);
  process.exit(1);
}
console.log(`Personal-data scan passed: ${paths.length} files.`);
