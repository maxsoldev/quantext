# Fixtures

Session logs recorded with scripted prompts on a generated dummy repo. The core and adapter tests (build step 3)
use them as golden input. One folder per harness version and scenario:

```
fixtures/
  claude-code/<version>/<scenario>/
    <session-id>.jsonl                          main transcript
    <session-id>/subagents/agent-<id>.jsonl     subagent transcripts (and their .meta.json)
    manifest.json                               what the scenario exercises, rows by type, LLM calls, cost
  tools/                                        record and normalise scripts, the dummy repo, the MCP server
  fixtures.test.ts                              every transcript parses and matches its manifest
```

**Real sessions are never committed.** Only recordings made by `fixtures/tools/record.ts` go here. Do not copy a
transcript from your own `~/.claude/projects/`, not even a short one, and do not edit fixtures by hand: record
again.

## Record

Prerequisites: `claude` on the `PATH` (the version you record for), Node ≥ 22.18, `git`, and model access through
environment variables: either Bedrock (`CLAUDE_CODE_USE_BEDROCK`, `AWS_REGION`, `AWS_BEARER_TOKEN_BEDROCK`) or
`ANTHROPIC_API_KEY`. The `ANTHROPIC_DEFAULT_*_MODEL` variables are passed through when set. Variables missing from
the environment are read from the `env` of `~/.claude/settings.json`.

```sh
node fixtures/tools/record.ts                    # all scenarios
node fixtures/tools/record.ts resume compaction  # some scenarios
node fixtures/tools/record.ts --keep image       # keep the raw recording in /tmp for inspection
```

The script writes `fixtures/claude-code/<claude --version>/<scenario>/` and prints the cost of each scenario.
**Cost:** the default model is used, so one full run costs real money, about US$0.75 on Claude Code 2.1.322 (Opus
5.5 on Bedrock). Record only the scenarios you changed. Exact model output differs on every run; that is expected.

Then run `corepack pnpm check` (tests, personal-data scan, history scan, gitleaks) and look at the diff before you
commit.

### Isolation

Each scenario runs in a fresh `/tmp/qxrec.XXXXXX/` root, so nothing of your own Claude Code setup reaches the
recording:

- `claude` runs under `env -i`-style isolation: a new environment with only `PATH` (the root's `bin/` with links
  to `claude` and `node`, then `/usr/bin:/bin:/usr/sbin:/sbin`), `HOME` (the root's `home/`), `TMPDIR`,
  `CLAUDE_CONFIG_DIR` (the root's `config/`), `LANG`, `GIT_CONFIG_NOSYSTEM=1`,
  `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, `DISABLE_AUTOUPDATER=1` and the auth variables above. No session
  variables of a calling Claude Code (`CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_MESSAGING_*`, …) pass through.
- The config holds only a `settings.json` written by the script: no hooks, plugins, MCP servers or instructions;
  `skipDangerousModePermissionPrompt` for `bypassPermissions`, and empty attribution (the default co-author line
  holds an email address). Every run passes `--strict-mcp-config`.
- The dummy repo (`tools/dummy-repo.ts`) holds only generated files, committed as
  `Fixture <fixture@example.invalid>` at a fixed date. `home/.gitconfig` has the same identity.
- The MCP scenario uses `tools/mcp-server.ts`, a stdio server with one tool and no network.

### Normalise and check

Before anything is written to the repo, `record.ts`:

1. **Normalises** (`tools/normalise.ts`): the recording root, also through the `/tmp` link and in Claude Code's
   dash-encoded form, becomes `/fixture` (`/fixture/repo`, `/fixture/home`, `/fixture/config`, `-fixture-repo`).
   Lines that hold no such path stay byte for byte.
2. **Keeps the hashes valid.** Claude Code names each message and each shape by sha256 of its JSON with sorted
   keys. A `tail` lists these hashes; each one is an `api-request-blob` row, a `user` or `assistant` row
   (role and content; an assistant message split over rows of one `message.id` is all of them, in order; a string
   prompt is one text block). When a placeholder changes a message or a shape, the normaliser recomputes its hash
   and rewrites every `tail` and `shapeHash` that pointed at it. `requestDigest` hashes the full wire request,
   which the log does not hold exactly; it stays as recorded and is an opaque id. Tail hashes that match no
   message are counted in `manifest.json` (`unresolvedTailHashes`) and the script warns.
   Usage numbers are never touched: they are the exact counts of what was sent, before normalisation.
3. **Scans** every file with the personal-data patterns of `scripts/lib/personal-data.ts`, this checkout's git
   email and host name, and **canary terms** from your real config (`tools/canary.ts`): each long line of
   `~/.claude/CLAUDE.md`, the names of your MCP servers, and your plugins from non-official marketplaces, plus
   `QX_CANARY_TERMS` (comma-separated) and your home path. These terms are read at run time and never stored. A
   hit means isolation failed: nothing is written, the scenario must not be committed, fix the isolation first.

## Add a scenario

1. Add an entry to `tools/scenarios.ts`: a name, a new fixed session id, what it exercises, and short prompts
   with a clear intent. Later steps run as `claude -p --resume <id>`.
2. If it needs files, add them to `tools/dummy-repo.ts` (generated, deterministic, no real content).
3. Record only that scenario, read the transcript, and check that it shows what the scenario is for.
4. Run `corepack pnpm check` and commit the scenario folder with its manifest.

## What the 2.1.322 recordings show

- 2.1.322 has no Glob or Grep tool; the model searches with Bash. MCP tools are deferred: after ToolSearch loads
  one, the next call has a new shape (`shapeHash`) with the tool schema added.
- `/compact` works headless as `claude -p --resume <id> "/compact"`. The summarising call has no `api-request`
  or `assistant` row; the log has a `system` row (`subtype: compact_boundary`, with `compactMetadata`), the summary
  as a `user` row with `isCompactSummary`, and the next call starts again at `keep: 0`.
- A resumed session's first call has `keep: 0` and a tail with every message.
- Subagent calls are in their own transcript, with `agentId` on each `api-request` and `querySource`
  `agent:builtin:<type>`.
