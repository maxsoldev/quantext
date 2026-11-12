/**
 * The no-egress guard on the shipped plugin (SECURITY.md): fail when a file in it could reach the network
 * other than the engine's server on 127.0.0.1. Usage: check-egress.ts [plugin dir, default dist/plugin].
 * Run `pnpm build:plugin` first (`pnpm egress` does both).
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { ShippedFile } from "./lib/egress.ts";
import { findEgress } from "./lib/egress.ts";
import { POLICY } from "./lib/egress-policy.ts";

const dir = process.argv[2] ?? join(import.meta.dirname, "..", "dist", "plugin");
if (!existsSync(join(dir, "engine", "engine.js"))) {
  console.error(`check-egress: ${dir} has no engine/engine.js; run pnpm build:plugin first`);
  process.exit(1);
}
const files: ShippedFile[] = [];
for (const entry of readdirSync(dir, { recursive: true, encoding: "utf8" })) {
  const path = join(dir, entry);
  if (statSync(path).isFile())
    files.push({ path: relative(dir, path).split(sep).join("/"), text: readFileSync(path, "utf8") });
}
const findings = findEgress(files, POLICY);
for (const f of findings) console.error(`${f.file}:${f.line}  ${f.rule}  ${f.detail}`);
if (findings.length > 0) {
  console.error(
    `\nNo-egress guard failed: ${findings.length} finding(s) in ${files.length} files (allowlist: scripts/lib/egress-policy.ts).`,
  );
  process.exit(1);
}
console.log(`No-egress guard passed: ${files.length} files.`);
