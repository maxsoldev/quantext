# 31. Conventional Commits, and release-please makes the release PR

Status: accepted

## Context

A release (ADR 30) was manual: bump the root version, merge, tag, push the tag, and the release notes came from
the PR titles. We want the version, the changelog and the tag made for us, and a person still to decide when to
release.

Options considered:

- **Manual tag with generated notes.** No new parts, but the version and the changelog stay manual.
- **semantic-release.** Releases on every merge with a `feat` or `fix`: no human gate.
- **Changesets.** Plain commit subjects stay, but every PR adds a `.changeset/*.md` file, and it is a dev dependency.
- **release-please.** A bot keeps one release PR open with the next version and `CHANGELOG.md`; merging it tags and
  creates the GitHub Release. It reads Conventional Commits, so the commit style changes. Chosen.

## Decision

- **Commits** follow Conventional Commits (`AGENTS.md`): `feat` is a minor bump, `fix` a patch, `!` or a
  `BREAKING CHANGE:` footer a major one. Before 1.0 a breaking change bumps the minor (`bump-minor-pre-major`).
- **The check** is `scripts/check-commits.ts` (subject rules in `scripts/lib/commit-message.ts`), not commitlint,
  which would add many dependencies for a few rules. The `commits` job in `ci.yml` checks every commit of a pull
  request except merges; `.githooks/commit-msg` checks one before it is pushed. Dependabot writes `build(deps)` and
  `ci(deps)` subjects; a bot's subject may be longer than 72, since we do not choose its words.
- **release-please** (`release-please-config.json`, `.release-please-manifest.json`, release type `node`, tags
  `v<version>`) runs as the first job of `release.yml` on each push to `main`, with `GITHUB_TOKEN` only. It writes
  the root `package.json` version, so ADR 30's one version stays. A tag made with `GITHUB_TOKEN` starts no other
  workflow, so the build, attest and publish jobs run in the same workflow when it reports a release. The publish
  job adds the files and the install notes to the release that release-please created. A tag pushed by hand still
  releases as before.
- **Permissions.** The release-please job writes contents, pull requests and issues (labels); the publish job
  writes contents. `scripts/workflows.test.ts` checks that no other job writes.

## Consequences

- The repo setting "Allow GitHub Actions to create and approve pull requests" must be on.
- A PR that `GITHUB_TOKEN` opens starts no workflow, so CI does not run on the release PR. It changes only the
  version, the changelog and the manifest, and the release build runs `pnpm check` before it publishes.
- With merge commits, each commit of a merged PR is one changelog line. Review fixes to unreleased work take the
  type of the work they correct, not `fix`.
- Commits before this ADR are not Conventional Commits, so the first changelog leaves them out.
