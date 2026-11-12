# 28. A no-egress guard on the shipped plugin, and supply-chain checks in CI

Status: accepted

## Context

Quantext reads private transcripts, and enterprise developers must be able to install it with confidence. The
promise is "fully local, no telemetry" (SECURITY.md). A promise in a README is not enough: a new dependency in
the viewer (React, step 8), a helper that fetches a URL, or a changed start script can break it without anyone
seeing. The dependency tree is the other risk: a vulnerable, re-licensed or taken-over package.

## Decision

**Static guard on the artefacts.** `pnpm egress` builds `dist/plugin/` and checks every shipped file, not the
sources, because bundling can bring in code the sources only reference. Code is checked on its AST
(`rolldown/parseAst`, already used by the layer check), not by regex: comments do not count, and a URL or argv is
followed through constants, templates, conditionals, helpers and their call sites (`scripts/lib/resolve.ts`).
What cannot be followed is a finding, so the guard errs on the side of failing. The allowlist
(`scripts/lib/egress-policy.ts`) is small and has a reason per entry.

**Runtime tripwire.** The smoke test preloads `scripts/lib/egress-trap.ts` into every engine process
(`NODE_OPTIONS=--import`, `BUN_OPTIONS=--preload`, inherited by children) and points `HTTP(S)_PROXY` at a sink.
Considered: Node's permission model (no network permission on Node 22 or 24; Bun has none); a Linux network
namespace (Linux only, and it shows a failure, not the attempt). The tripwire runs the same on macOS, Linux,
Node and Bun, and names the target.

**Supply chain.** pnpm 12 has what we need, so no extra tool is installed for it:

- `pnpm supply-chain` (in `pnpm check`): lockfile packages only from registry.npmjs.org with sha512
  integrity; ADR 7's settings kept; no install script or `binding.gyp` without an `allowBuilds` entry; licences
  of production dependencies on the allowlist (dev-only exceptions are reported). `build:plugin` writes
  `THIRD_PARTY_NOTICES.md` from the production dependencies.
- `.github/workflows/supply-chain.yml`: `pnpm audit --prod --audit-level=moderate` is the gate (only production
  dependencies ship); dev advisories and OSV-Scanner v2.7.1 over the whole lockfile are reported, because a
  pnpm lockfile does not tell OSV what is dev-only. `pnpm audit signatures` verifies registry signatures. `pnpm
  sbom` writes CycloneDX 1.7 SBOMs (plugin: production; build: all), kept as an artefact and attached to
  each published release. `actions/dependency-review-action` v5.0.0 fails a PR on new vulnerable or off-list
  licences (config `.github/dependency-review-config.yml`; a test keeps its licences equal to the check's).
- `.github/workflows/scorecard.yml`: OpenSSF Scorecard v2.5.0, weekly and on push to main.
- Dependabot for npm and GitHub Actions, weekly, grouped, with a one-day cooldown that matches
  `minimumReleaseAge: 1440`.
- Every action is pinned by commit SHA; each workflow has `contents: read` unless a job needs more.

## Consequences

- A new outbound call, CDN asset or command fails CI until it is on the allowlist with a reason.
- In the viewer's files the guard trusts the browser: the engine serves them with `default-src 'self'` and
  `connect-src 'self'`, and the guard checks that CSP, so a `fetch` URL it cannot follow (Vite's preload helper,
  an injected `fetch`) passes there; a URL known to be external fails. Checked on the viewer's current build.
- Dependency review and Scorecard need a public repo (or GitHub Code Security); while the repo is private they
  are skipped, and the other checks still run.
- The guard cannot see native code, and the tripwire does not reach Bun's worker threads; there is no native
  code, and the static guard covers the worker.
- Provenance: `trustPolicy: no-downgrade` refuses a version with less trust evidence than earlier ones;
  `pnpm audit signatures` checks signatures, not provenance attestations.
