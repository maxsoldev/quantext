# 13. Rolldown to bundle the engine into dist/engine.js

Status: accepted (to be configured in build step 7)

## Context

The release is one plugin folder. The engine must be one file, `dist/engine.js`, that `node` or `bun` starts with no
`node_modules`. The viewer is built with Vite, and Vite 8 bundles with Rolldown.

## Decision

Bundle the engine with Rolldown: ESM output for Node ≥ 22, with `node:*` and `bun:*` built-ins kept external, so the
store adapter for the current runtime is selected at run time (ADR 3). Step 1 adds no bundler config; build step 7
adds it, together with the engine entry point.

Considered: esbuild (also good, but one more toolchain and an install script); `bun build` (needs Bun on every
contributor's machine).

## Consequences

- One toolchain (Vite and Rolldown) for the viewer and the engine.
- A later compiled binary per platform (`bun build --compile`) is a separate step and needs its own ADR.
