# 10. Layer-dependency check as a small tested script on the Rolldown parser

Status: accepted

## Context

CI must fail when an import breaks the layer rules in `docs/ARCHITECTURE.md`. The rules go beyond "only import
downwards": each layer has an explicit list (`api` may not import `store`; `cli` is the composition root and may
import every layer); `core` imports no built-ins and no packages; imports from `@quantext/shared` must be type-only,
and shared holds no runtime code; the mod imports only `claude-code` and shared types; and no code may load a module
around `import` (`require`, `eval`). dependency-cruiser, the usual tool, cannot express all of this, and it needs the
TypeScript 5/6 compiler API to read `.ts` files, while we use TypeScript 7 (ADR 8).

## Decision

`scripts/check-layers.ts` parses every file under `packages/*/src` with `rolldown/parseAst` (Oxc), and
`scripts/lib/layers.ts` checks each import against a rule table:

| Engine layer | May import |
|---|---|
| core | nothing outside core except types from `@quantext/shared`: no built-ins, no packages |
| providers | core; no built-ins, no packages (ADR 16) |
| adapters | core, providers |
| store | core |
| ingest | core, providers, adapters, store |
| query | core, store |
| api | core, query |
| cli (composition root) | core, providers, adapters, store, ingest, query, api |

core is a shared kernel: every layer may import its pure functions. Every layer may import types from
`@quantext/shared` (ADR 14).

Packages: `engine`, `web` and `mod` may import `@quantext/shared`, types only. `shared` contains only types. Besides
relative paths and types from `@quantext/shared`, `mod` may import only the bare specifier `claude-code`: that is all
the Claude Code mod sandbox accepts. Each file is parsed by its extension (`.ts`, `.tsx`, `.mts`, `.cts`, `.js`,
`.jsx`, `.mjs`, `.cjs`). Relative imports may not leave their package. Engine files
must sit inside a layer. Dynamic imports need a literal specifier. `#` subpath imports, absolute and `file:`
specifiers, `node:module` (`createRequire`), `process.getBuiltinModule()` are not allowed, and engine and mod
code may not refer to `require` (also `module.require`, `import.meta.require`, `globalThis["require"]`), `eval` or
`Function` (also as a property, such as `globalThis.eval`), and may not call `.constructor()`, so nothing can load or run code around the check. A file that does not parse is a violation.

## Consequences

- No extra dependency: Rolldown is already installed through Vite and is the planned bundler (ADR 13).
- The rule table is code with tests; change it there, together with `docs/ARCHITECTURE.md`.
- An engine entry file (build step 7) must live in a layer (`cli/`) or the table must grow.
