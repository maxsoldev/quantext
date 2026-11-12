# 23. The query layer reads through a read-only connection, with TEMP views and demo mode

Status: accepted

## Context

Build step 6 adds the one read API for the CLI, the HTTP API, the viewer and the mod, and SQL for agents
(`qx sql`). Readers must work while an engine writes, must not be able to change the store, and must give the
same numbers whether they use the API or SQL. The meetup needs a demo mode that no consumer can forget to apply.

## Decision

- **Read-only connection.** `openReader` opens `quantext.db` with SQLITE_OPEN_READONLY, takes no writer lock,
  refuses another schema version, and sets `query_only` after its setup. WAL lets it read while the engine writes.
- **TEMP views.** The views of `docs/schema.md` ("Views") are made on each connection by the query layer, not
  by a migration: they change with the engine, need no write to the store, and exist only where the query layer
  reads. The query layer reads `v_sessions` itself, so SQL and the API share one definition.
- **`qx sql`** runs one statement that starts as a read and holds no word of a write or of a connection change,
  on the read-only connection, at most 1000 rows, with SQLite's authorizer denying all but reads where the runtime
  has one (Node 24). It runs in a child process that is killed after a time limit (30 s by default), because
  neither `node:sqlite` nor `bun:sqlite` can interrupt a statement; so it never runs in the engine.
- **Lifetime cost in SQL.** Each run is joined with the Calls of its lane through the index `calls_lane`, which
  holds what pricing needs: the store keeps per Call its tokens before the cache boundary and its price per token
  (schema v3), so a run is priced as read in all its Calls and corrected only where it lies at or after the
  boundary. The result equals core's `blockCosts` for every Call whose input tokens are its framing tokens.
- **Per Session, not by view.** A filter on a view comes after the whole view is computed, so the viewer and the
  API use `blockLifetimes(session)` and `toolOutputs(session)`, whose filter is inside.
- **Demo mode in the query layer.** `createQuery({ demo })` filters by project and redacts every string it gives
  out (paths relative to the project, home folders as `~`, the user name next to paths and addresses). `qx sql`
  does not apply it.

## Consequences

- The whole-corpus lifetime views take about 1.7 s on the real corpus (6.5 million Block-Call pairs); one
  Session's lifetimes take under 10 ms for most Sessions and about 130 ms for the largest.
- The HTTP API (step 7) builds a `createQuery` on its own read-only connection, with the same options.
- A consumer that needs demo mode must not read the store around the query layer.
