# 24. The HTTP API on node:http, with strict request checks and a resumable event stream

Status: accepted

## Context

Build step 7 puts the query layer on HTTP for the viewer and the mod, and streams change events. The engine runs
on Node and Bun, holds full transcripts, and must not be readable by any other web page (ADR 5). The viewer
reconnects after sleep or a network change and must not miss a Call.

## Decision

- **`node:http`, no framework.** About 20 GET routes need no framework; `node:http` runs on both runtimes and
  its limits (header size, header and request time, keep-alive) are set explicitly. Tests run on both.
- **Routes** under `/api/v1/` map one to one to query methods (`docs/api.md`). Every parameter is named, typed
  and bounded; an unknown or repeated one is a 400. Errors are JSON (`ApiError`) and never repeat the input. A
  Session hidden by demo mode is a 404, as is one that does not exist (`Query.hasSession`).
- **Request checks**, in this order: the `Host` is `127.0.0.1:<port>` or `localhost:<port>` (403); GET or HEAD
  (405); an `Origin` must be this origin (403); a `Sec-Fetch-Site` other than `same-origin` or `none` is refused
  (403), except a top-level navigation to a viewer page (a link from slides may open the viewer, it cannot read
  it); no body (413, and the connection is closed); a URL of at most 4096 characters (414); headers of at most
  16 KiB (431). At most 64 sockets; more are closed at once. A socket silent for 15 s is closed, and headers must
  arrive within 10 s however slowly they trickle (checked every 0.5 s); an open event stream is exempt. Bun's
  `node:http` shows a socket only after its first request, so there the count covers those, and Bun itself closes
  a silent or trickling socket after about 10 s (tested).
- **Headers.** Every response: `nosniff`, `no-referrer`, `X-Frame-Options: DENY`, `Cross-Origin-Resource-Policy:
  same-origin` (another page cannot even embed an image), `Cross-Origin-Opener-Policy: same-origin`, and no
  `Access-Control-*`. Pages get `default-src 'self'` with no inline script and `frame-ancestors 'none'`; every
  other response `default-src 'none'; sandbox`. API: `no-store`. Files under `assets/`: immutable; others
  `no-cache`. Media: PNG, JPEG, GIF and WebP inline, anything else as an `attachment` download.
- **Slow routes off the event loop.** `blocks` and `tool-outputs` price every Block over every Call of a Session
  (about 0.8 s at 2,000 Calls); they run in a worker thread with its own read-only connection and the same query
  options, so `/health` and the stream keep answering (guarded: p95 under 200 ms, also during a catch-up, whose
  batches are sized to about 40 ms).
- **Static files** come from one folder: only regular files whose real path (symbolic links resolved) is inside
  it, no dot files, no listing; a path with no extension that is no file is a viewer page (`index.html`).
- **Event stream** (`GET /api/v1/events`, SSE). Each ingest event passes `Query.visibleEvent`, then goes into a
  ring of the last 1024 events and to every stream. Event ids are `<cursor>.<n>` (the n-th event of one write);
  `ready` and `resync` have the id `<cursor>`, meaning all of it. A client resumes with `Last-Event-ID` or
  `?cursor=`: what the ring holds after it is replayed, then `ready`; when the ring no longer reaches back (or the
  cursor is from before this engine, or larger than the store's), it gets `resync` with `since`, and reads
  `/api/v1/sessions?changedSince=<since>` again. The replay is written in parts, each after the last drained (a
  client that does not drain in 30 s is dropped). A comment every 15 s keeps the stream; a live client whose unsent
  bytes pass 1 MiB is dropped, so memory never grows with a slow client. At most 16 streams (503). The ingest status (`/api/v1/status`) goes out as `ingest`, with
  no id, at most once a second. If an event
  cannot be checked, every stream is closed and the gap is marked, so that clients resync.

Considered: a framework (Fastify, Hono): more surface and dependencies for no feature we need. An event log table
in the store: replay beyond the ring is what `changedSince` already gives.

## Consequences

- The viewer is served by the engine and talks to it same-origin only; another origin cannot read or embed
  anything, even with DNS rebinding.
- A viewer needs one rule for gaps: on `resync`, read the changed Sessions again.
- The CSP allows no inline script or style element: the viewer's build must emit files (step 8).
