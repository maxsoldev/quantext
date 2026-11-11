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

  test("adapters and store may import only types from core", () => {
    const files = [
      engine("adapters", 'import type { Call } from "../core/index.ts";\nexport type * from "../core/index.ts";\n'),
      engine("store", 'import { hash } from "../core/index.ts";\n'),
    ];
    expect(findLayerViolations(files)).toEqual([
      {
        file: "packages/engine/src/store/index.ts",
        line: 1,
        specifier: "../core/index.ts",
        reason: "store may import only types from core (use `import type`)",
      },
    ]);
  });

  test("nothing above ingest imports adapters", () => {
    const files = [engine("query", '\n\nimport type { Row } from "../adapters/rows.ts";\n', "sessions.ts")];
    expect(findLayerViolations(files)).toEqual([
      {
        file: "packages/engine/src/query/sessions.ts",
        line: 3,
        specifier: "../adapters/rows.ts",
        reason: "query may not import adapters",
      },
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
        "file is outside the engine layers (core, adapters, store, ingest, query, api, cli)",
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

  test("mod imports nothing but types from shared and its own files", () => {
    const files = [
      {
        path: "packages/mod/src/index.ts",
        text: [
          'import type { Call } from "@quantext/shared";',
          'import { widget } from "./widget.ts";',
          'import { readFile } from "node:fs";',
          'import React from "react";',
        ].join("\n"),
      },
    ];
    expect(findLayerViolations(files).map((v) => [v.line, v.reason])).toEqual([
      [3, "mod runs in the mod sandbox and may import only types from @quantext/shared"],
      [4, "mod runs in the mod sandbox and may import only types from @quantext/shared"],
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
});
