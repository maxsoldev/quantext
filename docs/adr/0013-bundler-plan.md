# 13. Rolldown to bundle the engine into dist/engine.js

Status: accepted (configured in build step 7, see the end)

## Context

The release is one plugin folder. The engine must be one file, `dist/engine.js`, that `node` or `bun` starts with no
`node_modules`. The viewer is built with Vite, and Vite 8 bundles with Rolldown.

## Decision

Bundle the engine with Rolldown: ESM output for Node ≥ 22.18, with `node:*` and `bun:*` built-ins kept external, so the
store adapter for the current runtime is selected at run time (ADR 3). Step 1 adds no bundler config; build step 7
adds it, together with the engine entry point.

Considered: esbuild (also good, but one more toolchain and an install script); `bun build` (needs Bun on every
contributor's machine).

## Consequences

- One toolchain (Vite and Rolldown) for the viewer and the engine.
- A later compiled binary per platform (`bun build --compile`) is a separate step and needs its own ADR.

## Build step 7

`pnpm build` (`scripts/build-engine.ts`) runs one Rolldown build per entry: `dist/engine.js` (`qx`, with
`qx serve`), `dist/sql-child.js`, `dist/sql-watchdog.js` and `dist/query-worker.js`, plus the viewer's files in `dist/web/`. The only
split points are the store's two drivers, so each entry has two small chunks (`<entry>-node-driver.js`,
`<entry>-bun-driver.js`) that hold the one static import of `node:sqlite` or `bun:sqlite`: Bun resolves every
`import()` in a file when it loads it, so `node:sqlite` must not be in a file Bun loads, and one file per entry
is not possible. The build fails when an output imports anything but built-ins and its own chunks. `pnpm smoke`
runs the bundle end to end on Node and Bun, in CI on each job's runtime.
