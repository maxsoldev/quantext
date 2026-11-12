# 25. The engine process: port 4747, engine.json, one per data folder, idle exit

Status: accepted

## Context

ADR 4 starts the engine on request and keeps one per machine; ADR 22 makes the writer lock an OS file lock. A
second start (the mod's `/quantext view`, or `qx serve` by hand) must find the running engine and reuse it, and
an engine nobody uses must not stay.

## Decision

- **`qx serve`** is the engine: it opens the store (writer lock), opens a read-only connection for the query
  layer (with demo mode when asked), listens, writes `engine.json`, catches up (`ingestAll`), then watches the
  transcripts. Ingest events go to the event stream (ADR 24). Listening comes before the catch-up, so that a
  first run over a large corpus answers `/health` at once and the viewer sees the Calls arrive.
- **Port 4747** when it is free, else any free port. `--port` asks for one port and fails when it is taken. The
  port is in `engine.json`.
- **`engine.json`** in the data folder: `apiVersion`, `version`, `pid`, `port`, `url`, `startedAt`; no token or
  secret. Another process could have written it, so a reader checks every field (port 1–65535, pid, version,
  apiVersion), **ignores `url` and builds the URL from the port alone**, and prints nothing from it or from the
  answering `/health` without replacing control characters. The mod must do the same. Written whole (a temporary file, mode 0600, renamed) after the server listens, removed at a clean exit
  only while it still names this process.
- **A second start** reads `engine.json` and asks that port for `/health` (3 s at most). When the answer has the file's pid, the
  same `version` and the same `apiVersion`, it prints the URL (opens it with `--open`) and exits 0. Another
  version: it says which, with the pid to stop, and exits 1. No answer, or another pid: the file is stale and the
  start goes on. When the writer lock is held, it waits up to 5 s for an engine to answer (two starts at once),
  else exits 1 with the lock's message. The writer lock stays the guarantee; `engine.json` is only the hint.
- **Idle exit.** With `--live while-viewer` (the default) the engine stops after `--idle-minutes` (default 10)
  with no open event stream and no answered request (`/health` and refused requests do not count, so a mod
  that polls `/health` does not keep it; the mod keeps it with the stream while the viewer is open); with `--live always`, never.
- **Shutdown** on SIGINT, SIGTERM or idle: stop the catch-up or the watcher after the batch in progress (each
  batch's parser snapshot and offsets are written with it), end the event streams, close the sockets and both
  connections (releasing the lock), remove `engine.json`, exit 0. A second signal exits at once (130).
- **`--open`** runs `open` (macOS), `xdg-open` (Linux) or `rundll32 url.dll,FileProtocolHandler` (Windows; `start`
  is a shell built-in) with `execFile` and no shell; the URL is built from the port alone.

## Consequences

- A start costs one file read and one local request when an engine runs.
- The mod finds the engine by `engine.json` when 4747 was taken; probing 4747 alone is not enough.
- Engines of two versions never share a store: the newer one refuses until the older one is stopped.
- A new data folder is made mode 0700, and the database, the lock and `engine.json` are 0600: the store holds
  whole transcripts.
