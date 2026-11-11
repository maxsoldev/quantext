# 9. Vitest under Node, `bun test` under Bun, on the same test files

Status: accepted

## Context

The engine runs on Node ≥ 22.18 and on Bun, and the store has a different SQLite adapter on each. Tests must run on both
runtimes, from one set of files.

## Decision

Tests import `describe`, `test` and `expect` from `vitest`. Under Node, Vitest runs them (`pnpm test`). Under Bun,
`bun test` runs the same files: Bun maps `vitest` imports to its own runner (`pnpm test:bun`). Tests use only the API
that both runners share. Biome allows only `describe`, `test`, `it`,
`expect` and the before/after hooks from `vitest` (no `vi`, no namespace import), so tests pass fakes in as arguments
instead of module mocks.

Considered: `node:test` (no `expect` matchers; tests would read differently from the Vitest ones that the viewer
needs). Vitest started inside Bun (Vitest does not list Bun as a supported runtime; `bun test` is Bun's own runner and
loads `bun:sqlite` natively).

## Consequences

- No `vi.mock`, fake timers or snapshot files; pass clocks and I/O in as dependencies.
- Matchers outside the shared subset fail under Bun; CI runs both, so this shows at once.
