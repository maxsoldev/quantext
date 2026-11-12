# Security

Quantext reads private data: your Claude Code transcripts. This page says what it reads, what it writes, what
it sends over the network (nothing that leaves your machine), how we check that, and how to report a problem.

## The guarantee: fully local, no telemetry

| | What Quantext does |
|---|---|
| **Reads** | Claude Code's config folder (`~/.claude`, or `CLAUDE_CONFIG_DIR`), read-only: the transcripts `projects/<project>/*.jsonl` and the memory files `projects/<project>/memory/*.md`. The mod also reads each call's `usage` inside Claude Code, and `~/.quantext/engine.json`. |
| **Writes** | Only `~/.quantext/`: the store (`quantext.db` and its WAL files), `engine.json`, `engine.log`, the writer lock. The folder is created with mode 0700, the files with 0600. Nothing is written into the Claude Code folder or your projects. |
| **Network** | One HTTP server, bound to `127.0.0.1` only, for the viewer. It checks the `Host` header, refuses other origins and sends no CORS headers. The mod talks only to that server (`http://127.0.0.1:<port>/health`). |
| **Never** | No outbound connections. No telemetry, no analytics, no update checks, no crash reporting. The viewer loads no CDN script or font. |
| **Processes** | The mod starts the bundled engine with `node` or `bun`, runs `node --version`, `bun --version` and `uname -s`, and opens the viewer with `open` (macOS) or `xdg-open` (Linux). The engine starts copies of itself (the SQL child, a worker thread) and the opener. Nothing else. |

The store's tests check the modes (`packages/engine/test/store/store.test.ts`). The design is in
`docs/ARCHITECTURE.md` (principle 7, "What runs where") and ADR 5 (localhost-only API).

## How we check it

**The no-egress guard** (`pnpm egress`, part of `pnpm check` and CI). It builds the plugin (`dist/plugin/`: the
engine bundle and its workers, the mod's sources, the viewer's files) and reads every shipped file. Code is read
on its syntax tree (`rolldown/parseAst`), so comments do not count. It fails on:

- a hard-coded URL with a host other than `127.0.0.1`, `localhost` or `[::1]`, also in HTML, CSS and JSON;
- `fetch`, `EventSource`, `WebSocket` or `importScripts` to a URL that is not shown to be relative or loopback;
  the URL is followed through constants, templates, `+`, conditionals, helper functions and their call sites,
  and a URL that cannot be followed is a finding;
- any `XMLHttpRequest` or `navigator.sendBeacon`;
- `node:net`, `tls`, `dgram`, `dns`, `https`, `http2`, `cluster`, `inspector`, `module`, loaded in any way;
  a package import (shipped code is bundled); a module name that is not a literal;
- `node:http` requests to a host that is not loopback, and a server that does not listen on `127.0.0.1`;
- `child_process` `exec`, `execSync`, `fork`, a shell, and any command not on the allowlist; the runtime itself
  (`process.execPath`) may run a shipped file, but not `-e`/`--eval` or a preload;
- Bun's socket, server, process and cloud APIs (`Bun.connect`, `Bun.serve`, `Bun.spawn`, `Bun.s3`, …) and native
  bindings (`process.binding`, `process.dlopen`);
- in the mod: `$.telemetry`, `$.mcp`, `$.model`, `$.agent`, `$.audio`, `$.session.authorize`, `$.http` other than
  `fetch`, and `$.process.run` with an argv that is not on the allowlist.

The allowlist is `scripts/lib/egress-policy.ts`, with a reason per entry:

| Entry | Why |
|---|---|
| `https://platform.claude.com/docs/en/about-claude/pricing` | Cited as the source of the price table; never fetched |
| `https://nodejs.org`, `https://bun.sh` | Shown in the install hint when no runtime is found; never fetched |
| `open <url>`, `xdg-open <url>`, `rundll32 url.dll,FileProtocolHandler <url>` | Open the viewer in the browser |
| `node --version`, `bun --version`, `uname -s` | The mod finds a runtime and the opener |
| `sh -c <start script> node\|bun …` | The mod starts the engine detached; the script text is repeated in the policy, so a change to it fails the guard until it is reviewed |

XML namespace names (`http://www.w3.org/2000/svg` and the like) are names, not addresses, and always pass.
To change the allowlist, edit the policy in a commit that says why. Each rule has a failing case in
`scripts/lib/egress.test.ts`; add one when you add a rule.

**The runtime test** (`pnpm smoke`, CI on Node 22 and Bun). The smoke test starts the built engine over a
fixture, ingests it, serves the API and the event stream, runs `qx sql` and a second start, with a network
tripwire (`scripts/lib/egress-trap.ts`) preloaded into every process through `NODE_OPTIONS=--import` or
`BUN_OPTIONS=--preload`. The tripwire wraps the socket, TLS, UDP, DNS, `fetch` and `WebSocket` entry points,
logs each attempt to a host that is not loopback and refuses it. `HTTP(S)_PROXY` points at a local sink as well.
The test fails if the log is not empty or the sink saw a connection.

Limits, stated plainly: the guard is static, so a value it cannot follow fails the build rather than passes it;
it does not see native add-ons (there are none). The tripwire works in JavaScript: native code could pass it,
and on Bun it does not reach worker threads (the query worker only reads SQLite; the guard covers it). Node's
permission model was not used: it has no network switch on Node 22 or 24, and Bun has none.

## Reporting a vulnerability

Report it privately through GitHub: **Security → Report a vulnerability** on
[maxsoldev/quantext](https://github.com/maxsoldev/quantext/security/advisories/new). Do not open a public issue.
Say what you found, how to reproduce it, and which version. We answer within a week and fix critical and high
issues first.
