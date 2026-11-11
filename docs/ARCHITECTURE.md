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
7. **Local and safe by default.** The server binds `127.0.0.1`, checks the `Host` header, and has no CORS.
8. **One product, one install; the engine runs only on request.** The user installs one plugin. The harness features
   work at once, in-process. The engine starts only when the user asks for it (`/quantext view`), and stops after an
   idle period.
9. **One language.** TypeScript for the engine, viewer and mod, so types are shared directly, without generated
   clients.

## What runs where

| Part | Runs in | Can do | Cannot do |
|---|---|---|---|
| **Mod** | Claude Code's mod sandbox (no DOM, no Node; I/O only through `$`) | Read each call's `usage`, status line, toasts, commands, `/clear-tool-outputs`; `$.http.fetch` to the engine; start the engine with `$.process.run` | Open a server, use npm packages or Node built-ins, keep a child process alive (`$.process.spawn` dies with the session) |
| **Engine** | A separate Node ≥ 22.18 or Bun process, started detached | Watch and parse transcripts, write the store, serve HTTP + SSE and the viewer's files | — |
| **Viewer** | The browser | Read the engine's API | — |

### Starting the engine

`/quantext view`:

1. `$.http.fetch('http://127.0.0.1:<port>/health')`. If it answers, go to step 4.
2. Find a runtime: `node` ≥ 22.18, else `bun`, else show a clear message with install steps.
3. Start it detached: `$.process.run(['sh', '-c', 'nohup <runtime> "<plugin root>/dist/engine.js" >>"<log>" 2>&1 </dev/null &'])`.
   Poll `/health`.
4. Open the URL: `open` on macOS, `xdg-open` on Linux (there is no open-URL API in the mod).

The engine:

- keeps **one instance per machine** (a lock file in `~/.quantext/`, plus the port);
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
 surfaces     viewer (web)   mod (Claude Code plugin)   CLI (qx)   agents (SQL, skill, MCP later)
                  │                 │                     │              │
 api          HTTP JSON + SSE (shared TypeScript types) ◄─┴──────────────┘
                  │
 query        sessions · calls · context at call N · diffs · views
                  │
 store        SQLite (WAL), versioned schema, migrations          ◄── one writer: the engine
                  │
 ingest       watcher + incremental reader (byte offset per file, restart if a file shrinks)
                  │
 core         domain model ── context rebuild ── token attribution ── pricing (data)
                  │
 adapters     claude-code (JSONL + api-request* rows)   codex (later)   ...
```

| Layer | Responsibility | Depends on |
|---|---|---|
| **adapters** | Turn one harness's files into domain events: session, call (request + usage), block, tool call, compaction. Report unknown row types | core |
| **core** | Logic over the domain types defined in shared: rebuild the request of each call (`keep` + `tail` + blobs); split each call's input into blocks with tokens (exact deltas, then estimates); prices as data. Pure: no I/O, no built-ins, no packages | shared (types only) |
| **ingest** | Find files, read new bytes, call the adapter, write events in one transaction; watch files for live updates | adapters, core, store |
| **store** | Schema, migrations, writes, behind a driver interface (`node:sqlite`, `bun:sqlite`). WAL mode, so readers never block the writer | core |
| **query** | Read API: sessions, calls, context at call N, change from N-1, block lifetime cost. SQL views for agents | core, store |
| **api** | HTTP JSON + SSE events ("call added"), plus the viewer's static files. Request and response types live in a shared package | core, query |
| **cli** | The `qx` command and the composition root: wires store, ingest and api together (`qx serve`). No business logic | every layer below |
| **surfaces** | Viewer, mod, agent docs. No business logic: they only call the api (or the CLI) | api |

**core is a shared kernel.** Every engine layer may import core (pure functions). core imports nothing outside
itself except types from `@quantext/shared`, where the domain types (`Session`, `Call`, `Block`, …) and the API
types live; every layer may import those types. Besides core, a layer imports only the layers in its row: api must not import ingest or store, and
query must not import adapters or ingest. `scripts/check-layers.ts` enforces this table in CI.

The mod imports only the shared **types** from `@quantext/shared` (erased at build time) and `claude-code`, because
the mod sandbox accepts no other imports besides relative paths.

## Domain model

| Entity | One per | Key fields |
|---|---|---|
| `Session` | session or subagent | id, parent id, harness, harness version, project, cwd, started, ended |
| `Call` | LLM request | session, index, ts, model, params, shape hash, input / cache read / cache write / output tokens, cost |
| `Block` | unique content (by hash) | kind (system, tool schema, user, assistant, reasoning, tool call, tool result, reminder, image, summary), source (tool name, file path, MCP server, skill), tokens, token basis (exact / estimate) |
| `CallBlock` | block × call | position, in cached prefix or not |
| `ToolCall` | tool use | call, name, input, result block, error, duration |
| `Compaction` | compaction | session, before / after tokens, trigger |

Lifetime cost of a block, "context at call N", and "what changed at call N" are all queries over `CallBlock`.

## Live data flow

```
Claude Code appends JSONL ─► engine watcher ─► adapter (new bytes) ─► core ─► store ─► SSE "call added"
                                                                                         │
                                                       viewer updates · mod status line ◄┘
```

Hooks are not needed for ingest. When the engine is not running, nothing is ingested live; the next start catches
up, because the reader keeps a byte offset per file.

## Repository layout

pnpm workspace, one repo:

```
packages/
  shared/    domain and API types (no runtime code)
  engine/    adapters/, core/, ingest/, store/, query/, api/, cli/  → bundled to one file, dist/engine.js
  web/       live context viewer (React + Vite), built into the engine's static files
  mod/       Claude Code plugin; imports only types from shared
fixtures/    session logs recorded on a dummy repo, one folder per harness version and scenario
docs/        this file, schema docs, decision records (docs/adr/)
```

The release is one plugin folder: the mod, `dist/engine.js` and the built viewer.

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
- **Demo mode:** shows only the chosen projects, hides local paths. The meetup demo sessions are prepared
  separately and are not part of the repo.

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
| 8 | **Live context viewer**: reuse the eduagent visualiser components with a read-only Claude Code adapter; the teaching features and demo mode above | 1 | A running session updates in the browser call by call; meets the UX bar |
| 9 | **Mod**: status line, nudges, `/clear-tool-outputs` from in-process `usage`; `/quantext view` starts the engine and opens the viewer | 1 | Works on a fresh Claude Code install; harness features work with no Node or Bun |
| 10 | **Agent surface**: schema docs, a skill, MCP later | **2** | The reviewer questions are answered and checked in the viewer |

Code from the earlier prototype (the Python parser and incremental store, pricing, the mod widget) is ported inside
these steps.
