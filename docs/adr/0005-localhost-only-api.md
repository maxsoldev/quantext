# 5. Localhost-only API with a Host check and no CORS

Status: accepted

## Context

The store holds full transcripts: code, prompts, file contents, sometimes secrets. Any web page the user opens can
send requests to `127.0.0.1`, and DNS rebinding can make a remote name point there.

## Decision

The engine binds `127.0.0.1` only. It rejects every request whose `Host` header is not `127.0.0.1:<port>` or
`localhost:<port>`. It sends no CORS headers, so other origins cannot read responses. The engine makes no outbound
network calls and has no telemetry.

## Consequences

- The viewer must be served by the engine itself (same origin).
- No remote access, also not on a LAN. A future remote mode needs a new ADR.
- The mod reaches the engine with `$.http.fetch`, which is not a browser and is not limited by CORS.
