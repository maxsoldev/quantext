# `qx`, the command line

`qx` ingests the session logs into the store and reads it through the query layer, the same read API as the HTTP
API and the viewer. It makes no network calls. In the repo: `pnpm qx <command>` or
`node packages/engine/src/cli/qx.ts <command>` (Node ≥ 22.18 or Bun).

| Command | Does |
|---|---|
| `qx ingest [--root <dir>]` | Read what is new in the transcripts under `<dir>/projects` (default: `CLAUDE_CONFIG_DIR`, else `~/.claude`), and the projects' memory folders. Takes the writer lock: fails while an engine runs |
| `qx sessions [--project <p>] [--search <s>] [--sort ended\|started\|cost\|calls] [--limit <n>] [--offset <n>]` | Main Sessions, newest first, with their subagents |
| `qx session <id>` | One Session: totals, lanes, compactions (before, after, removed, kept), events, subagents |
| `qx call <session> <n> [--lane <lane>] [--diff]` | The context of Call `n` (its index in the Session; with `--lane`, the `n`-th Call of that lane): every Block in order with section, kind, source, tokens, basis, cached or not, cost share and a preview; totals by section and by context-bar group. `--diff`: what changed from the lane's previous Call |
| `qx outputs <session> [--sort cost\|tokens\|calls] [--limit <n>]` | The Session's tool outputs by lifetime cost (the query layer's `toolOutputs`; fast for one Session, unlike a filter on `v_tool_outputs`) |
| `qx blocks <session> [--sort cost\|tokens\|calls] [--limit <n>]` | The Session's Blocks by lifetime cost (`blockLifetimes`) |
| `qx sql "<select>" [--limit <n>] [--timeout <s>]` | One read-only statement over the tables and views (`docs/schema.md`, "Views"), in its own process, killed after `--timeout` seconds (default 30); at most 1000 rows by default |
| `qx report` | What ingest could not read or map, the Calls' issues by kind, bytes waiting for a newline |
| `qx serve [--root <dir>] [--port <n>] [--live while-viewer\|always] [--idle-minutes <n>] [--open]` | The engine: the HTTP API (`docs/api.md`) and the viewer on `127.0.0.1` (port 4747, else a free one; `--port`: that one or fail), live ingest. Takes the writer lock. When an engine of the same version already runs for this data folder, prints its URL and exits 0 (`--open`: opens it); another version: exit 1. Stops after `--idle-minutes` (default 10) with no viewer and no request, unless `--live always`, and on SIGINT or SIGTERM (ADR 25) |
| `qx --version`, `qx --help` | |

`qx serve` writes `engine.json` (port, pid, version, URL, start time) to the data folder while it runs.

Every reading command opens the store read-only (no writer lock), so it also works while an engine writes.

**Options for every command:** `--data-dir <dir>` (default `~/.quantext`), `--json`.

**A session** is named by its id, a prefix of it, or `<log>:<id>` when the same id is in more than one log.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Done (`ingest`: also when some files could not be read; they are listed on stderr and in `qx report`) |
| 1 | Failed: no store, a store of another schema version, the writer lock is held, a SQL error, a query over its time limit; `serve`: an engine of another version runs, or `--port` is taken |
| 2 | Wrong use: unknown command or option, a bad number, an ambiguous session, a statement that is not a single read (by the text check or SQLite's authorizer) |
| 3 | Not found: no such session or call |

## JSON output

With `--json`, stdout is one JSON value (two-space indented), the query layer's response type from
`packages/shared/src/query.ts`. Each response object has `apiVersion` (now 1): fields are added over time, and
renamed or removed only with a new `apiVersion`. An optional field is left out, not `null`. A field named `raw`
(`BlockDetail.raw.content`, `CallDetail.raw.params`) holds the provider's own data and is **not stable**.

| Command | JSON |
|---|---|
| `ingest` | `IngestSummary` (`packages/engine/src/ingest/ingest.ts`) and `ms` |
| `sessions` | `Page<SessionSummary>` |
| `session` | `SessionDetail` |
| `call` | `CallContext`; with `--diff`, also `diff: ContextDiff` |
| `sql` | `SqlResult`: `columns`, `rows` (objects by column name; a BLOB as `"<blob N bytes>"`), `truncated` |
| `report` | `QueryReport` |
| `outputs` | `Items<ToolOutput>` |
| `blocks` | `Items<BlockLifetime>` |
