# 4. Engine started on demand by the mod, detached, one instance, data in ~/.quantext

Status: accepted

## Context

The mod sandbox cannot open a server, and a child from `$.process.spawn` dies with the session. Users install one
plugin and expect it to cost nothing when they do not use the viewer. Uninstalling a plugin deletes its data folder.

## Decision

- The harness features (status line, nudges) run in the mod, in-process, with no engine.
- `/quantext view` checks `/health`, then starts the engine detached with `nohup` through `$.process.run`, then
  opens the browser.
- One engine per machine: a lock file in `~/.quantext/` plus the port. A second start reuses the running engine.
- The engine exits after an idle period with no viewer connected.
- The database and the log live in `~/.quantext/`, not in the plugin folder.

## Consequences

- No background process unless the user asks for one. Live ingest happens only while the engine runs; the next start
  catches up from the stored byte offset per file.
- Data survives plugin uninstall and update; removing it is a separate, explicit step.
- Interactive permission prompts for `$.process.run` are not tested yet (see `docs/ARCHITECTURE.md`).
