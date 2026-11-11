# 8. TypeScript 7, strict, type check only; Node runs the scripts directly

Status: accepted

## Context

We need strict type checks over four packages with different environments (Node for the engine, DOM for the viewer,
neither for the mod). TypeScript 7 (the native compiler) is the current release and is much faster than 6. Its
JavaScript compiler API is not stable yet.

## Decision

- TypeScript 7.0, `strict` plus `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax` and
  `erasableSyntaxOnly`.
- `tsc` only type checks (`noEmit`). Bundling is a separate step (ADR 13).
- One `tsconfig.base.json`; each package has its own `tsconfig.json` with its own `lib` and `types`. No project
  references: packages import each other's `.ts` source through the workspace, and each package is checked on its
  own (`pnpm -r typecheck`).
- Relative imports use the `.ts` extension. With erasable syntax only, Node ≥ 22.18 and Bun run the repo scripts
  directly, with no build step.

## Consequences

- No enums, namespaces or parameter properties (not erasable).
- Each package sees only the globals of its runtime: engine code cannot use DOM types, mod code cannot use Node types.
- Tools that need the TypeScript compiler API (for example dependency-cruiser) do not work with TypeScript 7 yet
  (see ADR 10).
- Contributors need Node ≥ 22.18 (`engines`). The built engine still runs on any Node ≥ 22.
