# Architecture

Quantext reads the session logs of coding agents (Claude Code first), rebuilds exactly what the model received on
every call, stores it locally, and shows it to people (a live web viewer, a status line in the harness) and to
agents (SQL, CLI, later MCP). Nothing leaves the machine.

## Principles

1. **One harness-neutral domain model.** Everything above the adapters speaks sessions, calls, blocks and tool
   calls, never Claude Code's JSONL rows. A new harness is a new adapter, not a change to the core.
2. **Pure core, thin edges.** Parsing, context rebuild and token attribution are pure functions over data, tested
   with golden fixtures. I/O (files, database, HTTP) sits at the edges.
3. **One writer, one ingest path.** The engine process is the only writer of the store. Batch import and live
   updates use the same incremental code.
4. **One query layer.** The CLI, the HTTP API, the viewer, the mod and agents all read through it. Only `qx sql`
   reads the tables directly, through documented views.
5. **Exact numbers first.** Token counts come from the API's `usage`. Estimates are used only to split a total, are
   marked as estimates, and must add up to the exact total.
6. **Fail loudly.** Unknown row types and numbers that do not reconcile are counted and shown, never dropped in
   silence.
7. **Local and safe by default.** The server binds `127.0.0.1`, checks the `Host` header, and has no CORS. Nothing
   connects out: no telemetry. A static guard on the built plugin and a runtime tripwire check it (ADR 28).
8. **One product, one install; the engine runs only on request.** The user installs one plugin. The harness features
   work at once, in-process. The engine starts only when the user asks for it (`/quantext view`), and stops after an
   idle period.
9. **One language.** TypeScript for the engine, viewer and mod, so types are shared directly, without generated
   clients.

## What runs where

| Part | Runs in | Can do | Cannot do |
|---|---|---|---|
| **Mod** | Claude Code's mod sandbox (no DOM, no Node; I/O only through `$`) | Read each call's `usage`, status line, toasts, commands, `/clear-tool-outputs`, `/clear-tool-calls`, `/clear-tools`; `$.http.fetch` to the engine; start the engine with `$.process.run` | Open a server, use npm packages or Node built-ins, keep a child process alive (`$.process.spawn` dies with the session) |
| **Engine** | A separate Node ≥ 22.18 or Bun process, started detached | Watch and parse transcripts, write the store, serve HTTP + SSE and the viewer's files | — |
| **Viewer** | The browser | Read the engine's API | — |

### Starting the engine

`/quantext view`:

1. `$.http.fetch('http://127.0.0.1:<port>/health')`, with the port from `~/.quantext/engine.json` (4747 when free;
   ADR 25). If it answers, go to step 4.
2. Find a runtime: `node` ≥ 22.18, else `bun`, else show a clear message with install steps.
3. Start it detached: `$.process.run(['sh', '-c', 'umask 077; mkdir -p "$3" && chmod 700 "$3" && cd "$3" && nohup "$0" "$1" serve --live while-viewer >>"$2" 2>&1 </dev/null &', runtime, '<plugin root>/engine/engine.js', log, dataDir])`,
   paths as arguments (ADR 27). Poll `/health` up to 10 s. Every command, the version probes too, runs in
   `<plugin root>/engine` and the engine in `~/.quantext/`, never in the project folder, so Bun loads no project
   `bunfig.toml` preload or `.env`. Trust boundary: `node`, `bun` and `open` resolve through PATH and the engine
   inherits Claude Code's environment, the same trust as the Bash tool.
4. Open the URL: `open` on macOS, `xdg-open` on Linux (there is no open-URL API in the mod).

The engine:

- keeps **one instance per machine** (an OS file lock in `~/.quantext/`, plus the port; ADR 22);
- **exits after an idle period** with no viewer connected (setting: `live ingest: while viewer open | always`);
- writes its database and log to **`~/.quantext/`**, not to the plugin's data folder, because uninstalling a plugin
  deletes that folder.

Verified on Claude Code 2.1.322 with a probe plugin: a detached `node` HTTP server started from `$.process.run`
kept running after the session ended, and `$.http.fetch` reached it. Interactive permission prompts for
`$.process.run` were not tested.

### Runtimes

- The native Claude Code install brings no Node or Bun. Most developers have one, but it is not guaranteed.
- The store goes through a small driver interface with two implementations, `node:sqlite` and `bun:sqlite`.
- The minimum is Node 22.18 (one number for users and contributors): `node:sqlite` works without a flag from
  22.13, and the repo scripts need type stripping without a flag, from 22.18.
- Later, to remove the runtime need: one compiled engine binary per platform (`bun build --compile`), shipped in
  the plugin.

## Layers

```
 surfaces   viewer (web)            mod (Claude Code plugin)            agents (SQL, skill, MCP later)
                │                            │                                    │
                └─────────── HTTP ───────────┤                                    │ qx …
                                             ▼                                    ▼
 api        HTTP JSON + SSE ◄────────────────────────── serves ──────────── cli   qx · the composition root:
                │                                                            │    wires store, ingest and api
                ▼                                                            │    (`qx serve`)
 query      sessions · calls · context at call N · diffs · views ◄───────────┤    commands read through query
                │                                                            │
                ▼                                                            ▼
 store      SQLite (WAL), versioned schema, migrations ◄─────────────── ingest   watcher + reader, the one writer
                                                                             │
                                                                             ▼
 adapters                                         claude-code (JSONL + api-request* rows) · codex (later) · …
                                                                             │
                                                                             ▼
 providers                                        anthropic (content blocks, estimates, prices) · openai (later)

 core       shared kernel, used by every layer: token attribution · reconciliation · pricing interface
 shared     domain and API types, types only, used by every package
```

| Layer | Responsibility | Depends on |
|---|---|---|
| **adapters** | Turn one harness's files into domain events: session, call (request + usage), block, tool call, compaction; rebuild the request of each call (in Claude Code: `keep` + `tail` + blobs). Report unknown row types | core, providers |
| **providers** | What one model provider defines: its content blocks (tool use, tool reference, deferred tools, thinking), the token estimate of each (Anthropic's image formula), its price list and price modifiers. Pure: no I/O, no built-ins, no packages | core |
| **core** | Logic over the domain types defined in shared, the same for every harness and provider: split each call's input into blocks with tokens (exact deltas, then reconciled estimates); the estimator and pricing interfaces; cost by cache part. Pure: no I/O, no built-ins, no packages | shared (types only) |
| **ingest** | Find files, read new bytes, call the adapter, write each batch in one transaction; watch files for live updates and tell which Calls were added | providers, adapters, core, store |
| **store** | Schema, migrations, writes, behind a driver interface (`node:sqlite`, `bun:sqlite`). WAL mode, so readers never block the writer. Rows are kept per log, with the adapter version that wrote them; content and media are stored once by hash. CallBlock runs are keyed by (log, session, lane, first call, position), so that "the blocks of call N" is a range lookup, not a scan (`docs/schema.md`, ADR 19, 20) | core |
| **query** | Read API: sessions, calls, context at call N, change from N-1, block lifetime cost. SQL views for agents | core, store |
| **api** | HTTP JSON + SSE events ("call added"), plus the viewer's static files. Request and response types live in a shared package | core, query |
| **cli** | The `qx` command and the composition root: wires store, ingest and api together (`qx serve`). No business logic | every layer below |
| **surfaces** | Viewer, mod, agent docs. No business logic: they only call the api (or the CLI) | api |

**core is a shared kernel.** Every engine layer may import core (pure functions). core imports nothing outside
itself except types from `@quantext/shared`, where the domain types (`Session`, `Call`, `Block`, …) and the API
types live; every layer may import those types. Besides core, a layer imports only the layers in its row: api must
not import ingest or store, and query must not import adapters or ingest. A harness (adapter) and a model provider
are separate axes: Claude Code may run on Anthropic models, Codex on OpenAI models (ADR 16). `scripts/check-layers.ts` enforces this
table in CI.

The mod imports only the shared **types** from `@quantext/shared` (erased at build time) and `claude-code`, because
the mod sandbox accepts no other imports besides relative paths.

## Domain model

| Entity | One per | Key fields |
|---|---|---|
| `Session` | session or subagent | id, parent id, harness, harness version, project, cwd, started, ended |
| `Call` | LLM request | session, index, lane, ts, model, params, shape hash, input / cache read / cache write / output / reasoning tokens, framing tokens, cache boundary, cache breakpoints, cost, issues |
| `Block` | unique content (by hash) | kind (tool schema, system, user, reminder, assistant, reasoning, tool call, tool result, image, document, summary), source (tool name, file path, MCP server, skill), content, parts (attached texts merged into it; ADR 29) |
| `CallBlock` | run of a block at one position over the calls of one lane | position, section, tokens, token basis (exact / derived / estimate), group, first call, last call |
| `ToolCall` | tool use | call, name, input, result block, error, duration |
| `Compaction` | compaction | session, before / after tokens, trigger |

Lifetime cost of a block, "context at call N", and "what changed at call N" are all queries over `CallBlock` runs
(ADR 17). Adapters parse incrementally: each read of new bytes gives a delta of new and updated entities and adapter
records, and the adapter's snapshot is a small JSON frontier that ingest persists; older content comes back through
a `ContentLookup` over the store (ADR 18).

## Live data flow

```
Claude Code appends JSONL ─► engine watcher ─► adapter (new bytes) ─► core ─► store ─► SSE "call added"
                                                                                         │
                                                       viewer updates · mod status line ◄┘
```

Ingest reads each log (a main transcript and its subagent transcripts) with one parser. It reads new bytes from
the byte offset of each file, in batches of complete lines (a line still being written waits for its newline),
and writes each batch's delta, the parser snapshot and the new offsets in one transaction; a stop signal ends a
pass after its batch, and the next pass goes on from there. The parsers of recently read logs stay warm between
passes. A file that is
replaced (new inode), cut below its offset, or rewritten (fingerprint) makes ingest delete the log's rows in one
transaction and read it again from the start. The watcher uses `fs.watch` (recursive) and polls where it cannot
watch; it gathers changes for a short window, reads the logs they belong to, and reports the Calls each write
added, for the SSE event. Transcripts are only ever opened read-only.

Hooks are not needed for ingest. When the engine is not running, nothing is ingested live; the next start catches
up, because the reader keeps a byte offset per file.

## Repository layout

pnpm workspace, one repo:

```
packages/
  shared/    domain and API types (no runtime code)
  engine/    adapters/, providers/, core/, ingest/, store/, query/, api/, cli/  → bundled to dist/engine.js (ADR 13)
  web/       live context viewer (React + Vite), built into the engine's static files
  mod/       Claude Code plugin; imports only types from shared
fixtures/    session logs recorded on a dummy repo, one folder per harness version and scenario
docs/        this file, the store schema (schema.md), decision records (docs/adr/)
```

The release is one plugin folder, `dist/plugin/` from `pnpm build:plugin`: the mod, the bundled engine and the built
viewer (ADR 27).

## Quality bar

No cut corners, in code, design or UX. There is no deadline that overrides this: a step is done only when it meets
its "done when" and the bar below.

- **Code:** TypeScript strict; small modules with one job; the dependency direction of the layers is checked in CI;
  tests at each layer (golden fixtures for the core, integration tests for ingest, store, API and the mod); no
  silent catch.
- **Design:** an ADR in `docs/adr/` for each decision that is hard to change (schema, API, runtime, packaging).
  The schema and the API are versioned.
- **UX:** the viewer is designed, not assembled: a clear information hierarchy, consistent visual language,
  keyboard navigation, readable on a projector, fast on sessions with thousands of calls (virtualised lists).
  Every number shows its basis (exact or estimate) and links to the calls it comes from.
- **Safety:** localhost only, Host check, no CORS, no telemetry; a secret scan in CI.

Issues found and deferred (not critical or high) are recorded in [`known-issues.md`](known-issues.md), with a
proposed fix.

## Release plan

### Release 1: harness features + live context viewer

Build steps 1–3 and 5–9 below. First audience: the next meetup, where the viewer is used to explain context
engineering.

Teaching features in the viewer (part of step 8):

- **Cache made visible:** for each call, the part read from the cache and the part written new, so the audience
  sees where and why the cache breaks.
- **Compaction before and after:** what was removed, what was kept, and the size of each.
- **The hidden part:** the system prompt and tool schemas, and their size before the first prompt.
- **Deferred tools:** MCP schemas that are sent only after ToolSearch loads them.

### Release 2

- **Agent surface** (step 10): schema docs, a skill, then MCP.
- **Codex adapter**, starting with the spike (step 4). Until then, the domain model is kept harness-neutral by
  review: no Claude Code names or row shapes above the adapter layer.

## Build order

Each step ends with tests, and later steps never reach below the layer they depend on.

| # | Step | Release | Done when |
|---|---|---|---|
| 1 | Skeleton: pnpm workspace, TypeScript strict, CI (tests, lint, type checks, layer-dependency check, secret scan), ADRs for the choices above | 1 | CI green |
| 2 | **Fixture corpus**: scripted sessions on a dummy repo (tools, subagent, image, error, compaction, resume, deferred MCP tool), recorded on the current Claude Code version | 1 | Fixtures checked in, with no personal data |
| 3 | **Core + Claude Code adapter**: domain types, context rebuild, token attribution, pricing. No database | 1 | For every fixture call: rebuilt input matches `usage`; blocks add up to the total |
| 4 | **Second-adapter spike** (Codex): map one Codex session to the same model | **2** | No change to core types needed, or the model is fixed |
| 5 | **Store + ingest**: driver interface, schema, migrations, incremental read, watcher | 1 | Re-ingest is idempotent; a file that grows gives only new rows; tests pass on Node and Bun |
| 6 | **Query layer + CLI**: `qx ingest`, `qx sessions`, `qx call`, `qx sql` with views | 1 | An agent answers "top tool outputs by lifetime cost" with `qx sql` |
| 7 | **API + engine process**: HTTP JSON + SSE, Host check, single instance, idle exit | 1 | SSE fires on a new call; a second start reuses the running engine |
| 8 | **Live context viewer**: reuse the eduagent visualiser components with a read-only Claude Code adapter; the teaching features above | 1 | A running session updates in the browser call by call; meets the UX bar |
| 9 | **Mod**: status line, nudges, `/clear-tool-outputs` from in-process `usage`; `/quantext view` starts the engine and opens the viewer | 1 | Works on a fresh Claude Code install; harness features work with no Node or Bun |
| 10 | **Agent surface**: schema docs, a skill, MCP later | **2** | The reviewer questions are answered and checked in the viewer |

Code from the earlier prototype (the Python parser and incremental store, pricing, the mod widget) is ported inside
these steps.
