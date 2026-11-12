import { describe, expect, test } from "vitest";
import { findLayerViolations } from "./layers.ts";

const engine = (layer: string, text: string, name = "index.ts") => ({
  path: `packages/engine/src/${layer}/${name}`,
  text,
});

describe("findLayerViolations", () => {
  test("a layer may not import from a layer above it", () => {
    const files = [engine("core", 'import { b } from "../adapters/index.ts";\nexport const c = b;\n')];
    expect(findLayerViolations(files)).toEqual([
      {
        file: "packages/engine/src/core/index.ts",
        line: 1,
        specifier: "../adapters/index.ts",
        reason: "core may not import adapters",
      },
    ]);
  });

  test("a layer may import from the layers below it and from itself", () => {
    const files = [
      engine(
        "ingest",
        [
          'import type { A } from "../core/index.ts";',
          'import { read } from "../adapters/index.ts";',
          'import { write } from "../store/index.ts";',
          'import { helper } from "./helper.ts";',
          'import { readFile } from "node:fs/promises";',
        ].join("\n"),
      ),
    ];
    expect(findLayerViolations(files)).toEqual([]);
  });

  test("core is a shared kernel: every layer may import its types and functions", () => {
    const layers = ["adapters", "store", "ingest", "query", "api", "cli"];
    const files = layers.map((layer) => engine(layer, 'import { rebuild, type Call } from "../core/index.ts";\n'));
    expect(findLayerViolations(files)).toEqual([]);
  });

  test("core imports nothing outside core, except types from shared", () => {
    const files = [
      engine(
        "core",
        [
          'import { a } from "./a.ts";',
          'import { readFile } from "node:fs";',
          'import { z } from "zod";',
          'import type { Session } from "@quantext/shared";',
          'import { Call } from "@quantext/shared";',
        ].join("\n"),
      ),
    ];
    expect(findLayerViolations(files).map((v) => [v.line, v.reason])).toEqual([
      [2, "core imports nothing outside core (no built-ins, no packages)"],
      [3, "core imports nothing outside core (no built-ins, no packages)"],
      [5, "import only types from @quantext/shared (use `import type`)"],
    ]);
  });

  test("cli is the composition root and may import every layer", () => {
    const layers = ["core", "providers", "adapters", "store", "ingest", "query", "api"];
    const text = layers.map((layer) => `import * as ${layer} from "../${layer}/index.ts";`).join("\n");
    expect(findLayerViolations([engine("cli", text)])).toEqual([]);
  });

  test("providers sit on core and are pure: no built-ins, no packages", () => {
    const files = [
      engine(
        "providers",
        [
          'import { reconcile } from "../../core/index.ts";',
          'import type { Call } from "@quantext/shared";',
          'import { createHash } from "node:crypto";',
          'import { x } from "../../adapters/index.ts";',
        ].join("\n"),
        "anthropic/index.ts",
      ),
    ];
    expect(findLayerViolations(files).map((v) => [v.line, v.reason])).toEqual([
      [3, "providers import nothing outside core and providers (no built-ins, no packages)"],
      [4, "providers may not import adapters"],
    ]);
  });

  test("adapters, ingest and cli may import providers; core, store, query and api may not", () => {
    const text = 'import { price } from "../providers/anthropic/index.ts";\n';
    const layers = ["core", "adapters", "store", "ingest", "query", "api", "cli"];
    expect(findLayerViolations(layers.map((layer) => engine(layer, text))).map((v) => v.reason)).toEqual([
      "core may not import providers",
      "store may not import providers",
      "query may not import providers",
      "api may not import providers",
    ]);
  });

  test("api reads only through query, and query never sees adapters or ingest", () => {
    const files = [
      engine("api", 'import { a } from "../ingest/index.ts";\nimport { b } from "../store/index.ts";\n'),
      engine("query", 'import { c } from "../adapters/index.ts";\nimport { d } from "../ingest/index.ts";\n'),
    ];
    expect(findLayerViolations(files).map((v) => v.reason)).toEqual([
      "api may not import ingest",
      "api may not import store",
      "query may not import adapters",
      "query may not import ingest",
    ]);
  });

  test("dynamic imports follow the same rules, and must use a literal specifier", () => {
    const files = [engine("core", 'const a = await import("../api/index.ts");\nconst b = await import(name);\n')];
    expect(findLayerViolations(files).map((v) => [v.line, v.reason])).toEqual([
      [1, "core may not import api"],
      [2, "dynamic import with a non-literal specifier cannot be checked"],
    ]);
  });

  test("engine code lives inside a layer", () => {
    const files = [
      { path: "packages/engine/src/main.ts", text: "export {};\n" },
      engine("cli", 'import { x } from "../util/x.ts";\n'),
    ];
    expect(findLayerViolations(files).map((v) => [v.file, v.reason])).toEqual([
      [
        "packages/engine/src/main.ts",
        "file is outside the engine layers (core, providers, adapters, store, ingest, query, api, cli)",
      ],
      ["packages/engine/src/cli/index.ts", "import target is outside the engine layers"],
    ]);
  });

  test("shared has no runtime code", () => {
    const files = [
      {
        path: "packages/shared/src/index.ts",
        text: [
          'export type * from "./call.ts";',
          'import type { Call } from "./call.ts";',
          "export interface Session { calls: Call[] }",
          "export type Basis = 'exact' | 'estimate';",
          "export {};",
          "export const VERSION = 1;",
        ].join("\n"),
      },
    ];
    expect(findLayerViolations(files).map((v) => [v.line, v.reason])).toEqual([[6, "shared may contain only types"]]);
  });

  test("other packages import only types from shared", () => {
    const files = [
      engine(
        "api",
        'import type { Session } from "@quantext/shared";\nimport { Session as S } from "@quantext/shared";\n',
      ),
      { path: "packages/web/src/index.ts", text: 'import { Call } from "@quantext/shared";\n' },
    ];
    expect(findLayerViolations(files).map((v) => [v.file, v.line, v.reason])).toEqual([
      ["packages/engine/src/api/index.ts", 2, "import only types from @quantext/shared (use `import type`)"],
      ["packages/web/src/index.ts", 1, "import only types from @quantext/shared (use `import type`)"],
    ]);
  });

  test("mod imports only claude-code, types from shared, and its own files", () => {
    const sandbox = "the mod sandbox accepts only relative imports, claude-code, and types from @quantext/shared";
    const files = [
      {
        path: "packages/mod/src/index.ts",
        text: [
          'import type { Call } from "@quantext/shared";',
          'import { widget } from "./widget.ts";',
          'import { readFile } from "node:fs";',
          'import React from "react";',
          'import { tool } from "claude-code";',
          'import { x } from "claude-code/internal";',
        ].join("\n"),
      },
    ];
    expect(findLayerViolations(files).map((v) => [v.line, v.reason])).toEqual([
      [3, sandbox],
      [4, sandbox],
      [6, sandbox],
    ]);
  });

  test("parses each file by its extension", () => {
    const files = [
      {
        path: "packages/web/src/App.tsx",
        text: 'import type { S } from "@quantext/shared";\nexport const App = () => <div />;\n',
      },
      { path: "packages/web/src/legacy.jsx", text: "export const Old = () => <p />;\n" },
      { path: "packages/mod/src/plain.mjs", text: 'import { readFile } from "node:fs";\n' },
      engine("cli", "export const n: number = 1;\n", "main.mts"),
    ];
    expect(findLayerViolations(files).map((v) => [v.file, v.reason.slice(0, 20)])).toEqual([
      ["packages/mod/src/plain.mjs", "the mod sandbox acce"],
    ]);
  });

  test("packages depend on each other only as allowed, and only by package name", () => {
    const files = [
      engine("api", 'import { App } from "@quantext/web";\n'),
      { path: "packages/web/src/index.ts", text: 'import type { Q } from "../../engine/src/query/index.ts";\n' },
    ];
    expect(findLayerViolations(files).map((v) => [v.file, v.reason])).toEqual([
      ["packages/engine/src/api/index.ts", "engine may not import @quantext/web"],
      ["packages/web/src/index.ts", "a relative import may not leave its package; import @quantext/<name> instead"],
    ]);
  });

  test("a file that does not parse is a violation, not a crash", () => {
    const [violation] = findLayerViolations([engine("core", "export const = ;\n")]);
    expect(violation?.reason).toMatch(/^cannot parse: /);
  });

  test("a package without rules is a violation, so new packages are not skipped", () => {
    const files = [{ path: "packages/tools/src/index.ts", text: "export {};\n" }];
    expect(findLayerViolations(files).map((v) => v.reason)).toEqual([
      "package tools has no layer rules; add it to scripts/lib/layers.ts",
    ]);
  });

  test("subpath, absolute and file: specifiers cannot bypass the rules", () => {
    const files = [
      engine(
        "query",
        [
          'import { a } from "#ingest/index.ts";',
          'import { b } from "/repo/packages/engine/src/ingest/index.ts";',
          'import { c } from "file:///repo/packages/engine/src/ingest/index.ts";',
        ].join("\n"),
      ),
    ];
    expect(findLayerViolations(files).map((v) => [v.line, v.reason])).toEqual([
      [1, "subpath imports (#...) are not allowed; use a relative path"],
      [2, "absolute and file: specifiers are not allowed; use a relative path"],
      [3, "absolute and file: specifiers are not allowed; use a relative path"],
    ]);
  });

  test("require cannot bypass the rules", () => {
    const files = [
      engine(
        "api",
        [
          'import { createRequire } from "node:module";',
          'import * as mod from "module";',
          'const store = require("../store/index.ts");',
          'const m = process.getBuiltinModule("module");',
        ].join("\n"),
      ),
    ];
    expect(findLayerViolations(files).map((v) => [v.line, v.reason])).toEqual([
      [1, "node:module (createRequire) is not allowed; use import"],
      [2, "node:module (createRequire) is not allowed; use import"],
      [3, "require is not allowed; use import"],
      [4, "process.getBuiltinModule() is not allowed; use import"],
    ]);
  });

  test("engine and mod code may not reach require, eval or Function in any form", () => {
    const text = [
      "const r = require;",
      'globalThis["require"]("x");',
      'module.require("x");',
      'import.meta.require("x");',
      'eval("1");',
      'new Function("return 1");',
      'Function("x")();',
      "const ok = { require: true, eval: 1 }; let f: Function; ok.evaluate; type R = typeof require;",
    ].join("\n");
    const files = [engine("query", text), { path: "packages/mod/src/index.ts", text: "const e = eval;\n" }];
    expect(findLayerViolations(files).map((v) => [v.file.split("/")[1], v.line, v.reason])).toEqual([
      ["engine", 1, "require is not allowed; use import"],
      ["engine", 2, "require is not allowed; use import"],
      ["engine", 3, "require is not allowed; use import"],
      ["engine", 4, "require is not allowed; use import"],
      ["engine", 5, "eval is not allowed"],
      ["engine", 6, "Function is not allowed"],
      ["engine", 7, "Function is not allowed"],
      ["mod", 1, "eval is not allowed"],
    ]);
  });

  test("eval, Function and .constructor() calls are caught as properties too", () => {
    const text = [
      'globalThis.eval("1");',
      'globalThis["eval"]("1");',
      'self.Function("x");',
      'f.constructor("return 1")();',
      "class A { constructor() {} } const n = this.constructor.name; o.evaluate();",
    ].join("\n");
    expect(findLayerViolations([engine("api", text)]).map((v) => [v.line, v.reason])).toEqual([
      [1, "eval is not allowed"],
      [2, "eval is not allowed"],
      [3, "Function is not allowed"],
      [4, ".constructor() calls are not allowed (they reach Function)"],
    ]);
  });
});
