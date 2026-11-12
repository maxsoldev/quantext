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
- a Content-Security-Policy directive in the engine that allows a host or scheme (only `'self'`, `'none'`,
  `data:`, `blob:`), or viewer files without a CSP whose `default-src` and `connect-src` are `'self'`. With that
  CSP the browser itself refuses other origins, so in the viewer's files (`engine/web/`) a `fetch` URL that
  cannot be followed passes (Vite's preload helper, a client that takes `fetch` as a parameter); one that is
  known to be external still fails;
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
| `https://react.dev/errors/` | React's minified error messages link to its docs (the viewer); never fetched |
| `engine/web/` as browser files | Served with the engine's CSP (see above) |
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

## How we keep dependencies safe

The plugin ships no third-party package today: the engine, the mod and the viewer are our own code, and the
engine bundle imports only Node and Bun built-ins. Every dependency is a build or test tool. When the viewer
bundles React, the same checks cover it. Decision: ADR 28; settings: ADR 7.

| Check | Where | Fails on |
|---|---|---|
| `pnpm install --frozen-lockfile` | CI | A package not in the lockfile, or a changed integrity hash |
| `strictDepBuilds: true`, `allowBuilds: {}` | `pnpm-workspace.yaml` | Any install script (pnpm refuses to install) |
| `minimumReleaseAge: 1440` | `pnpm-workspace.yaml` | A version less than one day old: the registry and the community get a day to find a hijacked release |
| `trustPolicy: no-downgrade` | `pnpm-workspace.yaml` | A version with less trust evidence (provenance, signatures) than earlier ones; `trustPolicyExclude` entries need a reason |
| `blockExoticSubdeps: true`, `saveExact: true` | `pnpm-workspace.yaml` | Git or tarball sub-dependencies; version ranges |
| `pnpm supply-chain` | `pnpm check` | A lockfile package not from registry.npmjs.org or without sha512 integrity; a weakened setting above; an entry without a reason; an installed package with an install script or `binding.gyp` and no `allowBuilds` entry; a production dependency with a licence off the allowlist |
| `pnpm audit --prod --audit-level=moderate` | `supply-chain.yml` | A known vulnerability (moderate or worse) in a shipped dependency. Dev ones are reported |
| OSV-Scanner v2.7.1 | `supply-chain.yml` | Reports known vulnerabilities in the whole lockfile (second database) |
| `pnpm audit signatures` | `supply-chain.yml` | A package without a valid npm registry signature |
| Dependency review v5.0.0 | `supply-chain.yml`, PRs | A new dependency with a known vulnerability or a licence off the allowlist (public repo only) |
| OpenSSF Scorecard v2.5.0 | `scorecard.yml` | Publishes the repo's score (public repo only) |
| Dependabot | `.github/dependabot.yml` | Proposes updates weekly, grouped, after a one-day cooldown |

`supply-chain.yml` runs on each PR, on push to main, and weekly, so an advisory published after a dependency
was added is found. Every GitHub Action is pinned by commit SHA, and workflows get `contents: read` only.

**Licence allowlist** (`LICENCE_ALLOWLIST` in `scripts/lib/supply-chain.ts`, and the same list in
`.github/dependency-review-config.yml`, kept equal by a test): MIT, MIT-0, Apache-2.0, BSD-2-Clause,
BSD-3-Clause, ISC, 0BSD, BlueOak-1.0.0, CC0-1.0, Unlicense, Python-2.0, CC-BY-4.0. The one exception is
dev-only: `lightningcss` (MPL-2.0), Vite's CSS tool, which runs at build time and ships nothing.
`dist/plugin/THIRD_PARTY_NOTICES.md` lists each bundled package with its licence text.

**SBOM.** `pnpm sbom` writes CycloneDX 1.7: `quantext-plugin.cdx.json` (what ships) and
`quantext-build.cdx.json` (everything, build tools too). CI keeps them as the `sbom` artefact and attaches them
to each published GitHub release.

**Adding a dependency.** Prefer the platform. If you must: a well-known package, an exact version at least a
day old, a licence on the list, no install script (else an `allowBuilds` entry with a comment that says why).
Run `pnpm check` (it runs `pnpm supply-chain` and the no-egress guard).

## Reporting a vulnerability

Report it privately through GitHub: **Security → Report a vulnerability** on
[maxsoldev/quantext](https://github.com/maxsoldev/quantext/security/advisories/new). Do not open a public issue.
Say what you found, how to reproduce it, and which version. We answer within a week and fix critical and high
issues first.
