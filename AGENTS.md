# Working in this repo

Read `docs/ARCHITECTURE.md` first. It is the source of truth for layers, the domain model, the release plan and the
quality bar. Decisions that are hard to change are recorded in `docs/adr/`.

## How we build

- **Test-driven.** Red, green, refactor. Write the failing test first, at the public interface of a module. Test
  behaviour, not implementation details. Use the `tdd` skill.
- **Vertical slices and tracer bullets.** Make one thin path work end to end first, then widen it. Every commit
  leaves the repo green.
- **Deep modules.** Small interfaces that hide real work. Use the `codebase-design` skill when you shape a module or
  a seam. Domain names follow `docs/GLOSSARY.md` (`domain-modeling` skill).
- **Layers.** A layer imports only from the layers below it (see the architecture). CI checks this. Nothing above
  `adapters/` knows Claude Code's row names or shapes.
- **No silent failure.** No empty `catch`. Unknown input is counted and reported. Numbers that do not reconcile are
  flagged.
- **UI work** uses the `frontend-design` and `dataviz` skills, and Playwright (tests in `e2e/`, plus the Playwright
  browser to look at the result while building).

## Code

- TypeScript strict, ESM, Node ≥ 22 and Bun. No `any` without a comment that explains it.
- Short docstrings (up to 5 lines) on exported functions and on tricky code. No comments that repeat the code.
- Small files with one job. Prefer pure functions in `core/`.

## Dependencies and security

- Add a dependency only when it clearly pays for itself. Prefer the platform (Node built-ins, Web APIs).
- Well-known packages only, exact versions, lockfile committed. Install scripts are off by default
  (`pnpm.onlyBuiltDependencies` lists the few that need them).
- The engine never makes outbound network calls. The server binds `127.0.0.1`, checks the `Host` header, and sends
  no CORS headers.
- **Never commit real session data.** Fixtures come only from the scripted dummy repo (`fixtures/README.md`) and must
  pass the personal-data scan. No local paths, user names, account names, emails or keys in the repo.

## Commits

- One logical change per commit, imperative subject. No co-author lines.
- Run `pnpm check` (lint, types, tests, layer check, secret scan) before each commit.
