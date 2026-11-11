# 11. Secret scan with gitleaks, personal-data scan with our own script

Status: accepted

## Context

The repo will hold recorded session logs (fixtures). These contain local paths, user names and emails, which are not
secrets to a secret scanner, and they can contain API keys. Neither must reach the repo.

## Decision

- `scripts/gitleaks.sh` downloads a pinned gitleaks release once into `.cache/`, checks its SHA-256 on every run, and scans the git
  history and the working tree with the default rules (`.gitleaks.toml`). The same script runs locally and in CI, so
  there is no third-party action and no licence key.
- `scripts/scan-personal-data.ts` scans every tracked and untracked, not ignored file, and each file path, for:
  home paths (`/Users/<name>`, `/home/<name>`, `/root`, `C:\Users\<name>` also JSON-escaped, Claude Code's
  dash-encoded project folders `-Users-<name>-…`, URL-encoded `%2FUsers%2F…`), emails outside reserved example
  domains, AWS access keys and `sk-` API keys. It also looks for this machine's user name, git email and host name;
  these terms are read at run time and never stored in the repo. Its patterns live in `scripts/lib/personal-data.ts`
  (`scanText`, `localDenylist`), so the fixture tooling (build step 2) reuses them. Output names the file, the line
  and the rule, never the matched value.

## Consequences

- Placeholders such as `/Users/<name>` and `~/.quantext` pass; real names do not. `/home/` inside web URLs and
  `git@host:` SSH remotes pass. Local names under 4 characters are not scanned for (too much noise); the path
  patterns still apply.
- Fixtures must be rewritten to placeholders before they are committed.
- The gitleaks script supports macOS and Linux on x64 and arm64 only. A new gitleaks version means new checksums.
