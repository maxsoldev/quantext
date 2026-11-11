/**
 * Fail when an import breaks the layer rules in docs/ARCHITECTURE.md.
 * Usage: check-layers.ts [repo root]. Checks every .ts/.tsx file under packages/<name>/src.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { SourceFile } from "./lib/layers.ts";
import { findLayerViolations } from "./lib/layers.ts";

const root = process.argv[2] ?? process.cwd();
const packagesDir = join(root, "packages");
const files: SourceFile[] = [];
for (const pkg of existsSync(packagesDir) ? readdirSync(packagesDir) : []) {
  const src = join(packagesDir, pkg, "src");
  if (!existsSync(src)) continue;
  for (const entry of readdirSync(src, { recursive: true, encoding: "utf8" })) {
    if (!/\.tsx?$/.test(entry)) continue;
    const absolute = join(src, entry);
    files.push({ path: relative(root, absolute).split(sep).join("/"), text: readFileSync(absolute, "utf8") });
  }
}

const violations = findLayerViolations(files);
for (const v of violations) {
  console.error(`${v.file}:${v.line}  ${v.reason}${v.specifier ? `  (${v.specifier})` : ""}`);
}
if (violations.length > 0) {
  console.error(`\nLayer check failed: ${violations.length} violation(s) in ${files.length} files.`);
  process.exit(1);
}
console.log(`Layer check passed: ${files.length} files.`);
