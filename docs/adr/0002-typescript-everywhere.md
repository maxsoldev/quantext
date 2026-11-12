# 2. TypeScript for engine, viewer and mod

Status: accepted

## Context

The mod must be TypeScript or JavaScript: the Claude Code mod sandbox runs nothing else. The viewer runs in the
browser. The earlier prototype parser and store were Python.

## Decision

Write the engine, the viewer and the mod in TypeScript, in one pnpm workspace. Domain and API types live in
`packages/shared` and are imported directly, as types only. We port the Python prototype instead of keeping it.

## Consequences

- No generated clients and no schema drift between engine, viewer and mod.
- The engine needs a JavaScript runtime (Node ≥ 22.18 or Bun) on the user's machine, until we ship a compiled binary.
- `packages/shared` must hold no runtime code, because the mod can import only erased types. The layer check enforces
  this.
