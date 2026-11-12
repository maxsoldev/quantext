# Known issues

Medium and low problems found in release 1, each with a proposed fix.

## Mod

- **Bedrock regional cost is low by 10%.** The footer label shows the harness's own session cost
  (`session.measure`'s `cost.usd`). Claude Code prices a Bedrock regional model id (`eu.`, `us.`, `apac.` …) at the
  list price, but those endpoints cost 10% more for Claude 4.5 models and later (the engine's pricing applies it).
  Fix: multiply by 1.1 when `$.session.model()` is a regional Bedrock id of such a model, or show the engine's cost
  once it runs.
- **No install straight from GitHub yet.** The marketplace entry points at `./dist/plugin`, which is built, not
  committed. Fix: a release job commits `dist/plugin` to a `plugin` branch and the entry's source names that ref
  (ADR 27).
- **CI does not run the mod's tests.** `pnpm test:mod` needs the `claude` CLI and skips loudly without it. Fix:
  install a pinned Claude Code in CI and set `QUANTEXT_REQUIRE_CLAUDE=1`.
- **Permission prompts for `/quantext view` are untested.** In an interactive session Claude Code may ask before
  each `$.process.run` (`node --version`, `uname`, `sh`, `open`). Fix: try it on a fresh install; if it asks four
  times, find the runtime with one `sh -c 'command -v node bun'` run and cache it in `$.store`.
- **`xdg-open` can block.** On some Linux desktops it waits for the browser; after 5 s the mod gives up and says
  "open it in a browser" although it opened. Fix: run it detached, as the engine is started.
- **The engine reports version 0.0.0.** The plugin is 0.1.0 (root package.json) but `packages/engine/package.json`
  is still 0.0.0, and `/health` reports that. Fix: give the engine the release version when release 1 is cut.
