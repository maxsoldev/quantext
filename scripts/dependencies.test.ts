import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

const root = join(import.meta.dirname, "..");

test("the direct rolldown pin is the same version that Vite resolves", () => {
  // The layer check uses rolldown/parseAst directly; Vite brings its own rolldown. Two versions would drift apart.
  const lock = readFileSync(join(root, "pnpm-lock.yaml"), "utf8");
  const versions = new Set([...lock.matchAll(/^ {2}'?rolldown@([^:('\s]+)/gm)].map((m) => m[1]));
  const pin = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).devDependencies.rolldown;
  expect([...versions]).toEqual([pin]);
});
