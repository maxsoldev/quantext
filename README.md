# Quantext

Quantext reads the session logs of coding agents (Claude Code first), rebuilds exactly what the model received on
every call, and shows where the context tokens go: in a live web viewer, in a status line inside the harness, and to
agents through SQL and a CLI. Nothing leaves the machine.

**Status: pre-release.** The repository holds the skeleton only. There is nothing to install yet.

## Requirements and setup (contributors)

- Node ≥ 22.18. Bun 1.3 or later to run the tests under Bun too.
- pnpm through Corepack. Node 25 and later ship without Corepack, so install it first:

  ```sh
  npm i -g corepack@latest && corepack enable
  pnpm install
  pnpm check        # lint, types, tests, layer check, scans
  pnpm check:bun    # the runtime-specific checks under Bun
  ```

  An older global pnpm may fail to switch itself to the pinned version. Then run `corepack pnpm …` instead.

## Docs

- [Architecture](docs/ARCHITECTURE.md): layers, domain model, release plan, quality bar.
- [Glossary](docs/GLOSSARY.md) and [decision records](docs/adr/).
- [Known issues](docs/known-issues.md): what we know is wrong or missing, and chose to defer.
- [Working rules](AGENTS.md) for contributors and coding agents.

Licence: [Apache-2.0](LICENSE).
