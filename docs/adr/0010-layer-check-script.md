# 10. Layer-dependency check as a small tested script on the Rolldown parser

Status: accepted

## Context

CI must fail when a layer imports from a layer above it. dependency-cruiser is the usual tool, but it needs the
TypeScript 5/6 compiler API to read `.ts` files, and we use TypeScript 7 (ADR 8). Our rules also go beyond direction:
some imports must be type-only, `shared` must hold no runtime code, and `mod` may import nothing but types.

## Decision

`scripts/check-layers.ts` parses every file under `packages/*/src` with `rolldown/parseAst` (Oxc), and
`scripts/lib/layers.ts` checks each import against a rule table:

| Engine layer | May import |
|---|---|
| core | nothing outside core: no built-ins, no packages |
| adapters | core |
| store | core |
| ingest | core, adapters, store |
| query | core, store |
| api | core, query |
| cli (composition root) | core, adapters, store, ingest, query, api |

core is a shared kernel: every layer may import its types and pure functions.

Packages: `engine`, `web` and `mod` may import `@quantext/shared`, types only. `shared` contains only types. `mod`
imports nothing else (the mod sandbox accepts no imports). Relative imports may not leave their package. Engine files
must sit inside a layer. Dynamic imports need a literal specifier. A file that does not parse is a violation.

## Consequences

- No extra dependency: Rolldown is already installed through Vite and is the planned bundler (ADR 13).
- The rule table is code with tests; change it there, together with `docs/ARCHITECTURE.md`.
- An engine entry file (build step 7) must live in a layer (`cli/`) or the table must grow.
