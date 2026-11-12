# 30. Releases publish the built plugin to a `plugin` branch; one version, in the root package.json

Status: accepted

## Context

A user should install with two commands and no clone or build:
`claude plugin marketplace add maxsoldev/quantext` and `claude plugin install quantext@quantext`. The marketplace
entry pointed at `./dist/plugin`, which is built and git-ignored (ADR 27), so a marketplace added from GitHub found
no plugin. The engine also reported its own version, 0.0.0, while the plugin was 0.1.0.

Plugin sources that Claude Code supports in `marketplace.json` (checked in the marketplace reference,
code.claude.com/docs/en/plugins/marketplace-reference, on Claude Code 2.1.322): a relative path in the marketplace;
`github` (`repo`, `ref`, `sha`); `url` (any git URL, `ref`, `sha`); `git-subdir` (`url`, `path`, `ref`, `sha`;
sparse checkout); `npm`; `archive` (an HTTPS zip, `sha256`); `command`. A relative path resolves only in the files
of the marketplace itself, so a git-ignored folder can never be installed from GitHub. A marketplace that is a local
folder is read in place; every other source is copied into the plugin cache, keyed by the plugin's version.

Options considered:

- **Commit `dist/plugin` to `main`.** A built bundle in every diff and every review, and a stale one between builds.
- **`archive` source on a release asset.** Needs the asset URL and its `sha256` in `marketplace.json` on `main`, so
  every release must also commit to `main`; and the asset host is a redirect to another domain.
- **`npm` source.** Needs a registry account and token: a second secret and a second publisher to trust.
- **`git-subdir` of a release tag.** Same as the archive: `main` must name each new tag.
- **`github` source with `ref: plugin`, a branch the release job owns.** `main` never changes on release; each
  release is one more commit on that branch, and users get it with `claude plugin update`. Chosen.

## Decision

- **Marketplace.** The repo-root `.claude-plugin/marketplace.json` (marketplace `quantext`) lists `quantext` with
  `"source": { "source": "github", "repo": "maxsoldev/quantext", "ref": "plugin" }`.
- **The `plugin` branch** holds the built plugin at its root (`.claude-plugin/plugin.json`, `hooks/`, `src/`,
  `engine/`, …), one commit per release, with no history of `main` (the first release is a root commit). Each commit
  says which source commit it was built from. Only the release workflow writes it.
- **Release workflow** (`.github/workflows/release.yml`, on a tag `v*`):
  1. `build` (`contents: read`): the tag must be `v` + the root version (`scripts/release.ts check-tag`); a clean
     `pnpm install --frozen-lockfile`; `pnpm check` (lint, types, tests, layers, secret scan, the no-egress guard
     on `dist/plugin`, supply chain); the engine smoke test on Node. Then a tarball of `dist/plugin`, the two
     CycloneDX SBOMs (ADR 28) and `SHA256SUMS`, kept as one artefact.
  2. `attest` (`id-token`, `attestations`, `artifact-metadata`: write; `contents: read`): build provenance for the
     tarball (`actions/attest`, Sigstore). Check with `gh attestation verify <tarball> --repo maxsoldev/quantext`.
  3. `publish` (`contents: write`, the only job with it): unpack the tarball (an artefact would drop `engine.js`'s
     mode), commit it as the next `plugin` commit (`scripts/release.ts commit-plugin`: a temporary index, no ignore
     rule applied, modes kept; it refuses a tree whose `plugin.json` is another version, or the same tree twice),
     push it as a fast-forward, and create the GitHub Release with the tarball, SBOMs and checksums.

  Only `GITHUB_TOKEN`; every action is pinned by SHA; `scripts/workflows.test.ts` checks both and that only the
  publish job writes contents. A release made with `GITHUB_TOKEN` starts no other workflow, so the SBOM job of
  `supply-chain.yml` on `release: published` is gone: the release job attaches the SBOMs itself.
- **Local development** keeps a folder marketplace read in place: `pnpm build:plugin` also writes
  `dist/.claude-plugin/marketplace.json` (marketplace `quantext-dev`, source `./plugin`). From a clone:
  `claude plugin marketplace add ./dist` and `claude plugin install quantext@quantext-dev`; a rebuild plus
  `/reload-plugins` updates it. Its own name lets the GitHub install and the development one live side by side.
- **One version.** The root `package.json` `version` is the release version (0.1.0). The engine imports it
  (`packages/engine/src/cli/version.ts`; the bundler inlines only the string), so `qx --version`, `/health`,
  `/api/v1/status` and `engine.json` name it, from source and from the bundle. `build:plugin` writes it into
  `plugin.json` and `engine/package.json`, which the mod compares with the running engine's `/health`. The
  engine's `package.json` has no version; the layer check lets only the engine's `cli` import the root
  `package.json`. The mod's source `plugin.json` keeps `0.0.0`, a placeholder that the build replaces.

## Consequences

- Install from GitHub needs a release first: until the first `v*` tag, the `plugin` branch does not exist and
  `claude plugin install quantext@quantext` fails at fetch. Development installs use `quantext-dev`.
- A developer who added the repo folder as marketplace `quantext` (ADR 27) now gets the GitHub source from it;
  they remove it and add `./dist` instead.
- To release: bump the root version, merge, tag `v<version>` on `main` and push the tag. A tag that does not match
  the version fails the first step. Users update with `claude plugin update quantext@quantext`.
- The branch is not protected by a review: anyone with push access could write it. A ruleset that lets only GitHub
  Actions push `plugin` would close that.
- `ref` is a branch, not a `sha`, so a user's install follows the newest release; pinning would need a commit to
  `main` per release.
