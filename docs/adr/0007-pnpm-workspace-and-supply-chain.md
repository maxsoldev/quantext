# 7. pnpm workspace with strict supply-chain settings

Status: accepted

## Context

The repo has four packages (`shared`, `engine`, `web`, `mod`) that share types. Install scripts and freshly published
or taken-over packages are the main supply-chain risks for a tool that reads private transcripts.

## Decision

- One pnpm workspace. `packageManager` pins pnpm 12.18.0 with its SHA-512; use it through Corepack.
- All tooling is a root dev dependency, at exact versions (`saveExact`), with the lockfile committed.
- `pnpm-workspace.yaml` states the security settings explicitly, so a change of defaults cannot weaken them:
  `allowBuilds: {}` with `strictDepBuilds: true` (no dependency runs install scripts; pnpm 11 replaced
  `onlyBuiltDependencies` with `allowBuilds`), `minimumReleaseAge: 1440`, `trustPolicy: no-downgrade`,
  `blockExoticSubdeps: true`.
- Every `allowBuilds` or `trustPolicyExclude` entry has a comment with the reason.

## Consequences

- A new dependency with an install script fails `pnpm install` until someone reviews it.
- Versions younger than one day cannot be installed; pick the previous release.
- `trustPolicyExclude` has one entry, `undici-types@6.21.0`: `@types/node@22` needs the 6.x line, which was published
  before undici added provenance to 7.x.
