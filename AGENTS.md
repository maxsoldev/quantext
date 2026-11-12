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
  browser to look at the result while building). The browser tools have no short time limit: race every
  `browser_evaluate` script against a timer (e.g. `Promise.race` with 10 s) and never await a condition that may not
  come. Put measurements in an e2e test, which has its own timeout. One stuck evaluate once cost 30 minutes.

## Code

- TypeScript strict, ESM, Node ≥ 22.18 and Bun. No `any` without a comment that explains it.
- Short docstrings (up to 5 lines) on exported functions and on tricky code. No comments that repeat the code.
- Small files with one job. Prefer pure functions in `core/`.

## Dependencies and security

- Add a dependency only when it clearly pays for itself. Prefer the platform (Node built-ins, Web APIs).
- Well-known packages only, exact versions, lockfile committed. Install scripts are off by default
  (`allowBuilds` in `pnpm-workspace.yaml` lists the few that need them, each with a reason).
- The engine never makes outbound network calls. The server binds `127.0.0.1`, checks the `Host` header, and sends
  no CORS headers. The no-egress guard (`pnpm egress`) checks the built plugin; a new URL or command
  needs an entry in `scripts/lib/egress-policy.ts` with a reason (SECURITY.md).
- **Never commit real session data.** Fixtures come only from the scripted dummy repo (`fixtures/README.md`) and must
  pass the personal-data scan. No local paths, user names, account names, emails or keys in the repo.

## Commits

- One logical change per commit. No co-author lines.
- **Subject:** imperative, about 50 characters, at most 72, no period at the end. It says *what* changed.
- **Body:** after one blank line, wrapped at 72. It says *why*, and anything a reviewer would not see in the diff
  (a trade-off, a rejected option, a link to an ADR or a known issue). Leave it out only for trivial commits.
- **Size:** keep a commit reviewable, as a rule under ~400 changed lines (lockfiles and recorded fixtures do not
  count). A larger commit says in its body why it cannot be split.
- Do not use `git stash` when several worktrees are in use: the stash is shared by all worktrees of the repo.
  Commit work in progress on your branch instead.
- Every commit passes `pnpm check` (lint, types, tests, layer check, secret scan, no-egress guard, supply-chain
  check) on its own. Do not amend or
  rebase commits that are already pushed.
