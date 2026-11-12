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
| `qx sql "<select>" [--limit <n>] [--timeout <s>]` | One read-only statement over the tables and views (`docs/schema.md`, "Views"), in its own process, killed after `--timeout` seconds (default 30); at most 1000 rows by default |
| `qx report` | What ingest could not read or map, the Calls' issues by kind, bytes waiting for a newline |
| `qx --version`, `qx --help` | |

Every reading command opens the store read-only (no writer lock), so it also works while an engine writes.

**Options for every command:** `--data-dir <dir>` (default `~/.quantext`), `--json`, `--demo` (hide local paths),
`--demo-project <p>` (demo mode with only these projects, by exact path; repeat for more).

**A session** is named by its id, a prefix of it, or `<log>:<id>` when the same id is in more than one log.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Done (`ingest`: also when some files could not be read; they are listed on stderr and in `qx report`) |
| 1 | Failed: no store, a store of another schema version, the writer lock is held, a SQL error, a query over its time limit |
| 2 | Wrong use: unknown command or option, a bad number, an ambiguous session, a statement that is not a single read, `sql` in demo mode |
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

## Demo mode

For showing sessions to an audience. Applied in the query layer, so the API and the viewer get the same:

- Only the allowed projects are visible (`--demo-project`, by exact path); every other Session, its Blocks, media,
  tool calls and memory are not found, and the report lists only their logs' entries (no folder scan issues).
- Every other project's path (as is, JSON-escaped, percent-encoded, as the harness's encoded folder name, and its
  folder name as a word of 4 or more characters) becomes `<hidden project>` wherever it shows in visible text.
- Percent-encoded text is decoded first. Paths in the project are shown relative to it (`src/a.ts`, the project
  itself as `.`), the project as its folder name; any home folder (macOS, Linux, Windows, with spaces or letters
  beyond ASCII, JSON-escaped or encoded, also `C--Users-<name>`) as `~`.
- The user name, in any case, is hidden after `@ / \ - : ~` and before `@` (`git@github.com:<name>/…`,
  `~<name>`, `<name>@host`), not inside other words. Errors on stderr are redacted the same way.
- Responses carry `redacted: true` and `blurImages: true`: the viewer blurs images, which may show what text hides.
- `qx sql` refuses to run in demo mode (exit 2): it reads the tables as they are.
