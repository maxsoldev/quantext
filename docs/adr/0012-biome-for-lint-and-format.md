# 12. Biome for linting and formatting

Status: accepted

## Context

We need a linter and a formatter for TypeScript and JSON, with few dependencies and fast runs in CI and editors.

## Decision

Use Biome (one exact-version package, a native binary, no install script) for both lint and format. `pnpm lint` runs
`biome ci .`; `pnpm format` writes fixes. Settings in `biome.json`: the recommended rules, `import type` for
type-only imports, no `any`, no empty blocks, no `vi` import. Markdown is not formatted, so tables in the docs keep
their hand layout.

Considered: ESLint with typescript-eslint and Prettier (more rules, including type-aware ones, but about ten times the
dependencies and two tools to configure).

## Consequences

- No type-aware lint rules; `tsc` strict covers most of that gap.
- One config file and one dependency to update.
