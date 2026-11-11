/**
 * Fail when the repo contains personal data (see lib/personal-data.ts).
 * Usage: scan-personal-data.ts [--history] [repo root].
 * Default: tracked and untracked files that git does not ignore, and their paths. --history: every line that any
 * commit on any ref added. Also looks for this checkout's git email and this machine's host name, read at run time.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { localDenylist, scanPatch, scanText } from "./lib/personal-data.ts";

const args = process.argv.slice(2);
const history = args.includes("--history");
const root = args.find((arg) => arg !== "--history") ?? process.cwd();
const git = (...gitArgs: string[]) =>
  execFileSync("git", ["-c", "core.quotepath=off", ...gitArgs], { cwd: root, encoding: "utf8", maxBuffer: 2 ** 30 });

const gitEmail = () => {
  const result = spawnSync("git", ["config", "user.email"], { cwd: root, encoding: "utf8" });
  return result.status === 0 ? result.stdout : ""; // exit 1: no email configured
};
const deny = localDenylist({ email: gitEmail(), hostname: hostname() });

/** Lines of `where  rule`. Never the matched value, so the output does not leak what it found. */
const findings: string[] = [];
let scope: string;

if (history) {
  const log = git("log", "-p", "--all", "--no-color", "--no-ext-diff", "--no-textconv", "--format=commit %H");
  for (const f of scanPatch(log, { deny })) findings.push(`${f.commit} ${f.path}  ${f.kind}`);
  scope = `history of ${git("rev-list", "--all", "--count").trim()} commits`;
} else {
  const listing = git("ls-files", "-z", "--cached", "--others", "--exclude-standard");
  const paths = listing.split("\0").filter((path) => path !== "" && existsSync(join(root, path)));
  for (const path of paths) {
    for (const f of scanText(path, { deny })) findings.push(`${path}  (path)  ${f.kind}`);
    const bytes = readFileSync(join(root, path));
    if (bytes.includes(0)) continue; // binary file
    for (const f of scanText(bytes.toString("utf8"), { deny })) findings.push(`${path}:${f.line}  ${f.kind}`);
  }
  scope = `${paths.length} files`;
}

if (findings.length > 0) {
  for (const line of findings) console.error(line);
  console.error(`\nPersonal-data scan failed: ${findings.length} finding(s). Replace them with placeholders.`);
  process.exit(1);
}
console.log(`Personal-data scan passed: ${scope}, ${deny.length} local identity terms.`);
