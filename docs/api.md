# The HTTP API

The engine (`qx serve`) serves the query layer over HTTP on `127.0.0.1`, for the viewer and the mod. The response
bodies are the query layer's types (`packages/shared/src/query.ts`), the same as `qx … --json` (`docs/cli.md`);
the API's own types are in `packages/shared/src/api.ts`. Every response object has `apiVersion` (now 1). Rules and
reasons: ADR 5, ADR 24.

## Routes

All are GET (or HEAD). `:log` and `:id` are a Session's key (`SessionKey`); `:n` a Call's index in its Session.

| Route | Query method | Parameters |
|---|---|---|
| `/health` | | `Health`: `ok`, `version`, `apiVersion`, `pid`, `startedAt`, `dataDir` |
| `/api/v1/status` | | `EngineStatus`: `engine` (`version`, `pid`, `startedAt`), `ingest` (`phase`: `catching-up`, `live`, `stopping`; `logsDone`, `logsTotal`, `bytesDone`, `bytesTotal` of the pass in progress or the last one, its `startedAt`, `lastError`), `streams` |
| `/api/v1/sessions` | `listSessions` | `project`, `search` (≤ 200), `sort` (`ended` `started` `cost` `calls`), `order` (`asc` `desc`), `changedSince`, `limit` (1–500, default 50), `offset` |
| `/api/v1/projects` | `listProjects` | `Items<ProjectSummary>`: `project` (as Sessions show it), `sessions`, `ended`, latest first |
| `/api/v1/session-keys` | `findSessions` | `id` (an id or its prefix) |
| `/api/v1/sessions/:log/:id` | `getSession` | |
| `/api/v1/sessions/:log/:id/calls` | `listCalls` | `lane`, `afterIndex`, `limit` (1–5000) |
| `/api/v1/sessions/:log/:id/calls/:n` | `getCall` | |
| `/api/v1/sessions/:log/:id/calls/:n/context` | `contextAt` | |
| `/api/v1/sessions/:log/:id/calls/:n/diff` | `contextDiff` | |
| `/api/v1/sessions/:log/:id/timeline` | `callTimeline` | |
| `/api/v1/sessions/:log/:id/tool-calls` | `toolCalls` | |
| `/api/v1/sessions/:log/:id/tool-outputs` | `toolOutputs` | `sort` (`cost` `tokens` `calls`), `limit` |
| `/api/v1/sessions/:log/:id/blocks` | `blockLifetimes` | `sort`, `limit` |
| `/api/v1/sessions/:log/:id/compactions` | `compactions` | |
| `/api/v1/sessions/:log/:id/cache-breaks` | `cacheBreaks` | |
| `/api/v1/blocks/:log/:hash` | `getBlock` | |
| `/api/v1/blocks/:log/:hash/media/:media` | `getMedia` | the bytes; PNG, JPEG, GIF, WebP inline, others as a download |
| `/api/v1/memory` | `projectMemory` | `project` (needed) |
| `/api/v1/report` | `ingestReport` | |
| `/api/v1/events` | `publicEvent` | SSE, below; `cursor` |
| anything else | | the viewer's files; a path with no extension gets `index.html` |

**Errors** are JSON (`ApiError`): `{ apiVersion, error: { status, code, message } }`. 400 `bad-request`: an
unknown, repeated, mistyped or out-of-range parameter; 404 `not-found`: no such route, Session, Call, Block or media; 403 `forbidden-host`, `forbidden-origin`, `forbidden-site`; 405
`method-not-allowed`; 413, 414, 431: a body, a long URL, large headers; 503 `too-many-streams`, `busy` (too many slow queries wait), `timeout` (a query over 30 s), `stopping`.

## The event stream

`GET /api/v1/events`, as `text/event-stream`. Events:

| Event | id | data |
|---|---|---|
| `calls` | `<cursor>.<n>` | `PublicEvent` of kind `calls`: `cursor`, `session`, `added` (`id`, `index`), `updated`. One per Session each write changed; both lists empty when only the Session changed (its end, title, events), so the stream's cursor keeps up with the store's |
| `memory` | `<cursor>.<n>` | `{ kind, cursor, projects }` |
| `log-removed` | `<cursor>.<n>` | `{ kind, cursor, logId }` (its Sessions are read again from the start) |
| `resync` | `<cursor>` | `SseResync`: `cursor`, `since`. Read `/api/v1/sessions?changedSince=<since>` again |
| `ingest` | none | `SseIngest`: the `ingest` part of `/api/v1/status`, at most once a second while it changes, the latest last; not replayed |
| `ready` | `<cursor>` | `SseReady`: `cursor`, `replayed`. After the replay; live events follow |

`<cursor>` is the store's change cursor after the write, `<n>` the event's place among the events of that write.
A client that comes back (the browser sends `Last-Event-ID`, or `?cursor=<id>`) gets every event after that id
that the engine still holds, else `resync`. `: ping` comes every 15 s. A client that does not read is dropped;
it reconnects and resumes.
