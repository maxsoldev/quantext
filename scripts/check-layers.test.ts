import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, test } from "vitest";

const script = join(import.meta.dirname, "check-layers.ts");
let root = "";

afterEach(() => rmSync(root, { recursive: true, force: true }));

/** Write `files` into a fresh temp repo and run the layer check on it. */
function runOn(files: Record<string, string>) {
  root = mkdtempSync(join(tmpdir(), "qx-layers-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return spawnSync(process.execPath, [script, root], { encoding: "utf8" });
}

test("passes when every import respects the layers", () => {
  const result = runOn({
    "packages/engine/src/core/index.ts": "export const one = 1;\n",
    "packages/engine/src/ingest/index.ts": 'import { one } from "../core/index.ts";\nexport const two = one + 1;\n',
  });
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
});

test("fails and names the file when a layer imports from a layer above it", () => {
  const result = runOn({
    "packages/engine/src/core/index.ts": 'import { two } from "../ingest/index.ts";\nexport const three = two + 1;\n',
    "packages/engine/src/ingest/index.ts": "export const two = 2;\n",
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("packages/engine/src/core/index.ts:1");
  expect(result.stderr).toContain("core may not import ingest");
});

test("checks JavaScript and JSX files too", () => {
  const result = runOn({
    "packages/engine/src/core/index.ts": "export const one = 1;\n",
    "packages/engine/src/core/legacy.mjs": 'import { x } from "../api/index.ts";\n',
    "packages/engine/src/api/index.ts": "export const x = 1;\n",
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("packages/engine/src/core/legacy.mjs:1");
});
