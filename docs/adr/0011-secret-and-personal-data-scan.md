# 11. Secret scan with gitleaks, personal-data scan with our own script

Status: accepted

## Context

The repo will hold recorded session logs (fixtures). These contain local paths, user names and emails, which are not
secrets to a secret scanner, and they can contain API keys. Neither must reach the repo.

## Decision

- `scripts/gitleaks.sh` downloads a pinned gitleaks release once into `.cache/`, checks its SHA-256, and scans the git
  history and the working tree with the default rules (`.gitleaks.toml`). The same script runs locally and in CI, so
  there is no third-party action and no licence key.
- `scripts/scan-personal-data.ts` scans every tracked and untracked, not ignored file, and each file path, for home
  paths (`/Users/<name>`, `/home/<name>`, `C:\Users\<name>`), emails outside reserved example domains, AWS access
  keys and `sk-` API keys. Its patterns live in `scripts/lib/personal-data.ts` (`scanText`), so the fixture tooling
  (build step 2) reuses them. Output shows only the start of each match.

## Consequences

- Placeholders such as `/Users/<name>` and `~/.quantext` pass; real names do not.
- Fixtures must be rewritten to placeholders before they are committed.
- The gitleaks script supports macOS and Linux on x64 and arm64 only. A new gitleaks version means new checksums.
