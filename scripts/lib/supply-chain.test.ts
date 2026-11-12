import { describe, expect, test } from "vitest";
import {
  buildScriptProblems,
  licenceAllowed,
  licenceProblems,
  lockfileProblems,
  notices,
  workspaceProblems,
} from "./supply-chain.ts";

const lock = (entries: string) =>
  `lockfileVersion: '9.0'\n\nimporters:\n\n  .: {}\n\npackages:\n\n${entries}\nsnapshots: {}\n`;
const SHA = "sha512-AAAA==";

describe("lockfileProblems", () => {
  test("registry packages with integrity pass", () => {
    expect(lockfileProblems(lock(`  'a@1.0.0':\n    resolution: {integrity: ${SHA}}\n`))).toEqual([]);
  });

  test("a package without integrity, from a tarball elsewhere, from git or a folder fails", () => {
    const text = lock(
      [
        "  b@1.0.0:\n    resolution: {tarball: https://registry.npmjs.org/b/-/b-1.0.0.tgz}\n",
        `  c@1.0.0:\n    resolution: {integrity: ${SHA}, tarball: https://example.com/c.tgz}\n`,
        "  d@git+https://github.com/x/d.git#abc:\n    resolution: {type: git, repo: https://github.com/x/d.git, commit: abc}\n",
        "  e@file:../e:\n    resolution: {directory: ../e, type: directory}\n",
      ].join("\n"),
    );
    expect(lockfileProblems(text)).toEqual([
      "b@1.0.0: no integrity hash",
      "c@1.0.0: resolved from https://example.com/c.tgz, not registry.npmjs.org",
      "d@git+https://github.com/x/d.git#abc: resolved from git or a folder",
      "e@file:../e: resolved from git or a folder",
    ]);
  });

  test("an importer that names a package by URL, git or file fails; workspace links pass", () => {
    const text =
      "importers:\n\n  .:\n    dependencies:\n      a:\n        specifier: github:x/a\n        version: x\n      b:\n        specifier: workspace:*\n        version: link:../b\n\npackages: {}\n";
    expect(lockfileProblems(text)).toEqual(["importer dependency a: specifier github:x/a is not a registry version"]);
  });
});

describe("workspaceProblems", () => {
  const good = [
    "saveExact: true",
    "strictDepBuilds: true",
    "# reason",
    "allowBuilds: {}",
    "minimumReleaseAge: 1440",
    "trustPolicy: no-downgrade",
    "blockExoticSubdeps: true",
    "trustPolicyExclude:",
    "  # Same repo, published before provenance.",
    "  - undici-types@6.21.0",
  ].join("\n");

  test("the current settings pass", () => {
    expect(workspaceProblems(good)).toEqual([]);
  });

  test("a weakened or missing setting fails", () => {
    const weak = good
      .replace("minimumReleaseAge: 1440", "minimumReleaseAge: 60")
      .replace("strictDepBuilds: true\n", "");
    expect(workspaceProblems(weak)).toEqual([
      "strictDepBuilds must be true",
      "minimumReleaseAge must be at least 1440",
    ]);
  });

  test("an allowBuilds or trustPolicyExclude entry without a comment fails", () => {
    const text = good
      .replace("allowBuilds: {}", "allowBuilds:\n  # needs its native binary\n  esbuild: true\n  sharp: true")
      .replace("  # Same repo, published before provenance.\n", "");
    expect(workspaceProblems(text)).toEqual([
      "allowBuilds entry sharp has no comment with its reason",
      "trustPolicyExclude entry undici-types@6.21.0 has no comment with its reason",
    ]);
  });
});

describe("buildScriptProblems", () => {
  test("an install script or a native build is a problem unless allowBuilds names the package", () => {
    const pkgs = [
      { name: "a", version: "1.0.0", scripts: { postinstall: "node x.js" }, gyp: false },
      { name: "b", version: "1.0.0", scripts: {}, gyp: true },
      { name: "c", version: "1.0.0", scripts: { install: "node y.js" }, gyp: false },
      { name: "d", version: "1.0.0", scripts: { test: "vitest" }, gyp: false },
    ];
    expect(buildScriptProblems(pkgs, ["c"])).toEqual([
      "a@1.0.0 has a postinstall script and no allowBuilds entry",
      "b@1.0.0 has a native build (binding.gyp) and no allowBuilds entry",
    ]);
  });
});

describe("licences", () => {
  const allow = ["MIT", "Apache-2.0", "ISC"];

  test("an SPDX expression passes when one OR branch has only allowed licences", () => {
    expect(licenceAllowed("MIT", allow)).toBe(true);
    expect(licenceAllowed("(MIT OR GPL-3.0)", allow)).toBe(true);
    expect(licenceAllowed("MIT AND ISC", allow)).toBe(true);
    expect(licenceAllowed("MIT AND GPL-3.0", allow)).toBe(false);
    expect(licenceAllowed("UNKNOWN", allow)).toBe(false);
  });

  test("licenceProblems names each package with a licence off the list", () => {
    const pkgs = [
      { name: "a", version: "1.0.0", license: "MIT" },
      { name: "b", version: "2.0.0", license: "GPL-3.0-only" },
    ];
    expect(licenceProblems(pkgs, allow)).toEqual(["b@2.0.0: GPL-3.0-only is not on the licence allowlist"]);
  });

  test("notices list each bundled package with its licence text, or say there is none", () => {
    expect(notices([])).toMatch(/no third-party packages/);
    const text = notices([{ name: "a", version: "1.0.0", license: "MIT", text: "MIT License\nCopyright A" }]);
    expect(text).toContain("## a 1.0.0 (MIT)");
    expect(text).toContain("Copyright A");
  });
});
