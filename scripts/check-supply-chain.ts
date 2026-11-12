/**
 * Supply-chain checks (SECURITY.md, "How we keep dependencies safe"): the lockfile's sources and integrity,
 * the pnpm-workspace.yaml settings, no install scripts without allowBuilds, and the licences of production
 * dependencies (dev-only licences off the list are reported, not failed).
 * Usage: check-supply-chain.ts [--notices <file>] writes THIRD_PARTY_NOTICES for the bundled packages instead.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { installedPackages, licenceText, licensed } from "./lib/installed.ts";
import {
  buildScriptProblems,
  LICENCE_ALLOWLIST,
  licenceProblems,
  lockfileProblems,
  notices,
  workspaceProblems,
} from "./lib/supply-chain.ts";

const repo = join(import.meta.dirname, "..");
const { values } = parseArgs({ options: { notices: { type: "string" } } });

const prod = licensed(repo, true);
if (values.notices !== undefined) {
  writeFileSync(values.notices, notices(prod.map((p) => ({ ...p, text: licenceText(p.path) }))));
  process.exit(0);
}

const workspace = readFileSync(join(repo, "pnpm-workspace.yaml"), "utf8");
const allowBuilds = [
  ...(/^allowBuilds:\s*\n((?:\s+.*\n)*)/m.exec(workspace)?.[1] ?? "").matchAll(/^\s+([^#\s][^:]*):/gm),
].map((m) => m[1]?.replace(/['"]/g, "") ?? "");
const npmrc = existsSync(join(repo, ".npmrc")) ? readFileSync(join(repo, ".npmrc"), "utf8") : "";
const problems = [
  ...lockfileProblems(readFileSync(join(repo, "pnpm-lock.yaml"), "utf8")),
  ...workspaceProblems(workspace),
  ...[...npmrc.matchAll(/^\s*(?:@[^:]+:)?registry\s*=\s*(\S+)/gm)]
    .filter((m) => !m[1]?.startsWith("https://registry.npmjs.org"))
    .map((m) => `.npmrc sets another registry: ${m[1]}`),
  ...buildScriptProblems(installedPackages(repo), allowBuilds),
  ...licenceProblems(prod, LICENCE_ALLOWLIST),
];
const prodNames = new Set(prod.map((p) => `${p.name}@${p.version}`));
const devOnly = licenceProblems(
  licensed(repo, false).filter((p) => !prodNames.has(`${p.name}@${p.version}`)),
  LICENCE_ALLOWLIST,
);
for (const p of devOnly) console.log(`note (dev only, not shipped): ${p}`);
for (const p of problems) console.error(p);
if (problems.length > 0) {
  console.error(`\nSupply-chain check failed: ${problems.length} problem(s).`);
  process.exit(1);
}
console.log(
  `Supply-chain check passed: lockfile, workspace settings, install scripts, ${prod.length} production licence(s).`,
);
