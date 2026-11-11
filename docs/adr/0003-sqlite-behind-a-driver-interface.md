# 3. SQLite store behind a node:sqlite / bun:sqlite driver

Status: accepted

## Context

The engine runs on Node ≥ 22 or Bun, whichever the user has. Native SQLite packages (for example `better-sqlite3`)
need install scripts or prebuilt binaries per platform and runtime, and they break the single-file engine bundle.
Both runtimes now have a built-in SQLite module.

## Decision

The store uses SQLite in WAL mode. It talks to SQLite only through a small driver interface with two adapters:
`node:sqlite` and `bun:sqlite`. The engine selects the adapter at start from the runtime it runs on. The schema is
versioned and changed only by migrations.

## Consequences

- No native dependency and no install script for the database.
- Store tests run on both runtimes (build step 5), so the two adapters cannot drift.
- The driver interface holds only what both modules support. No runtime-specific SQLite features above the driver.
- `node:sqlite` is not marked stable in Node 22. We accept this and pin the behaviour we use with tests.
