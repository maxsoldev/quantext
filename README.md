# Quantext

Quantext reads the session logs of coding agents (Claude Code first), rebuilds exactly what the model received on
every call, and shows where the context tokens go: in a live web viewer, in a status line inside the harness, and to
agents through SQL and a CLI. Nothing leaves the machine.

**Status: pre-release.** The repository holds the skeleton only. There is nothing to install yet.

## Privacy and security

Quantext is **fully local**. It has **no telemetry**, no analytics, no update checks and no crash reporting, and it
makes **no outbound connections**.

- **Reads**, read-only: Claude Code's transcripts and memory files under `~/.claude` (or `CLAUDE_CONFIG_DIR`).
- **Writes** only `~/.quantext/` (folder 0700, files 0600).
- **Network**: one HTTP server on `127.0.0.1`, for the viewer. The mod talks only to it.

CI enforces this on the files we ship: a static no-egress guard reads the built plugin, and the engine's smoke
test runs with a network tripwire. Details, and how to report a vulnerability: [SECURITY.md](SECURITY.md).

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
- [Security](SECURITY.md): what Quantext reads, writes and sends, and how we check it.

Licence: [Apache-2.0](LICENSE).
