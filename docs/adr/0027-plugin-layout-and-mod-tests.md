# 27. One plugin folder: the mod, the bundled engine and the viewer; mod tests under claude plugin test

Status: accepted

## Context

Principle 8: the user installs one plugin. The harness features run in-process in Claude Code's mod sandbox (no
Node, no packages; only relative imports, `claude-code`, and erased type imports), and `/quantext view` starts the
bundled engine (ADR 4, 25). The plugin must hold the engine's files next to the mod, and the mod must find them
from `$.plugin.root`. The mod's tests need Claude Code's own test kit (`claude-code/testing`), which only
`claude plugin test` provides.

## Decision

- **Source** is `packages/mod/`, itself a plugin folder: `.claude-plugin/plugin.json` (version `0.0.0` in the
  source), `hooks/hooks.json` naming `../src/register.ts`, `src/*.ts` (layer-checked: only relative imports,
  `claude-code`, and `import type` from `@quantext/shared`), `types/index.d.ts` (the `$.state` contract), and
  `test/*.test.ts`. Claude Code loads the TypeScript itself, so the mod is not bundled. A file that passes `$`
  to a function in another file must declare it with `function`: the loader follows `$` only into those.
- **`pnpm build:plugin`** (`scripts/build-plugin.ts`) runs `pnpm build` and writes `dist/plugin/`:

  ```
  dist/plugin/
    .claude-plugin/plugin.json   name quantext, author maxsoldev, version from the root package.json
    hooks/hooks.json             { "modules": ["../src/register.ts"] }
    src/*.ts  types/index.d.ts   the mod as written
    LICENSE
    engine/                      packages/engine/dist without source maps:
      engine.js sql-child.js sql-watchdog.js query-worker.js and their -node-driver / -bun-driver chunks
      web/                       the viewer's files
      package.json               { "type": "module", "version": <engine version> }
  ```

  `engine/package.json` makes the `.js` files ES modules for Node (no syntax detection) and is where the mod reads
  the bundled engine's version, which it compares with the running engine's `/health`.
- **Marketplace.** The repo-root `.claude-plugin/marketplace.json` (marketplace `quantext`) lists the plugin with
  `"source": "./dist/plugin"`. From a built clone: `claude plugin marketplace add <clone>` and
  `claude plugin install quantext@quantext`. A folder marketplace is read in place, so a rebuild plus
  `/reload-plugins` updates the install.
- **Engine start** (`/quantext view`, never on its own):
  `$.process.run(["sh", "-c", 'umask 077; mkdir -p "$3" && chmod 700 "$3" && cd "$3" && nohup "$0" "$1" serve --live while-viewer >>"$2" 2>&1 </dev/null &', runtime, "<root>/engine/engine.js", "~/.quantext/engine.log", "~/.quantext"])`.
  Paths are arguments, never part of the script. umask 077 and chmod 700 keep the data folder and the log private.
  The probes and `sh` run with `cwd` `<root>/engine` and the script `cd`s into the data folder: the engine never
  runs from the project folder, whose `bunfig.toml` or `.env` Bun would load. `node`, `bun` and `open` resolve
  through PATH and the engine inherits Claude Code's environment: the same trust as the Bash tool.
- **Mod tests and types.** `pnpm test:mod` runs `claude plugin validate` and `claude plugin test` on
  `packages/mod`; `pnpm check` includes it and says loudly when `claude` is not on PATH (it skips then).
  Vitest and Bun skip `packages/mod` (`vitest.config.ts`; `bun test` is given the other folders). The API's
  declarations are vendored as `packages/mod/vendor/claude-code.d.ts` (written by Claude Code 2.1.322), so
  `tsc` checks the mod in CI; refresh it from the plugin-authoring skill's `types/` when Claude Code updates.

## Consequences

- `dist/` is not committed, so a marketplace added straight from GitHub finds no plugin. Publishing needs a
  built folder in git: a release job that commits `dist/plugin` to a `plugin` branch (or a tag), with a marketplace
  entry whose source is that git ref. Until then, install from a built clone.
- CI does not run the mod's tests (no `claude` there). Installing the CLI in CI would close the gap.
- The engine keeps its own version (`packages/engine/package.json`); the plugin's version is the root one.
