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
node fixtures/tools/record.ts --keep image       # keep the raw recording in /tmp for debugging
node fixtures/tools/record.ts --check            # canary and secret scan of the committed fixtures
```

The script writes `fixtures/claude-code/<claude --version>/<scenario>/` and prints the cost of each scenario.
**Cost:** the default model is used, so one full run costs real money, about US$0.95 on Claude Code 2.1.322 (Opus
5.5 on Bedrock). Record only the scenarios you changed. Exact model output differs on every run; that is expected.

Then run `corepack pnpm check` (tests, personal-data scan, history scan, gitleaks) and look at the diff before you
commit.

### Isolation

Each scenario runs in a fresh `/tmp/qxrec.XXXXXX/` root, so nothing of your own Claude Code setup reaches the
recording:

- `claude` runs under `env -i`-style isolation: a new environment with only `PATH` (the root's `bin/` with links
  to `claude` and `node`, then `/usr/bin:/bin:/usr/sbin:/sbin`), `HOME` (the root's `home/`), `TMPDIR`,
  `CLAUDE_CONFIG_DIR` (the root's `config/`), `LANG`, `TZ=UTC`, `GIT_CONFIG_NOSYSTEM=1`,
  `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, `DISABLE_AUTOUPDATER=1` and the auth variables above. No session
  variables of a calling Claude Code (`CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_MESSAGING_*`, …) pass through
  (`tools/isolation.ts`, tested). The root is removed after each scenario, also on failure, unless `--keep`.
- The config holds only a `settings.json` written by the script: no hooks, plugins, MCP servers or instructions;
  `skipDangerousModePermissionPrompt` for `bypassPermissions`, and empty attribution (the default co-author line
  holds an email address). Every run passes `--strict-mcp-config`.
- The dummy repo (`tools/dummy-repo.ts`) holds only generated files, committed as
  `Fixture <fixture@example.invalid>` at a fixed date. `home/.gitconfig` has the same identity.
- The MCP scenario uses `tools/mcp-server.ts`, a stdio server with one tool and no network.

### Normalise and check

Before anything is written to the repo, `record.ts`:

1. **Normalises** (`tools/normalise.ts`): the recording root, resolved and in Claude Code's dash-encoded form,
   becomes a placeholder **of the same length**: `/private/tmp/qxrec.Ab12Cd` becomes `/fixture-0000000000000000`
   (so `/fixture-0000000000000000/repo`, `-fixture-0000000000000000-repo`). Every string keeps its length, so
   content sizes and token estimates are the recorded ones. Lines that hold no such path stay byte for byte. Any
   other spelling of the root (such as `/tmp/qxrec.…`) is not mapped; the check in step 3 then fails.
2. **Keeps the hashes valid.** Claude Code names each message and each shape by sha256 of its JSON with sorted
   keys. A `tail` lists these hashes; each one is an `api-request-blob` row, a `user` or `assistant` row
   (role and content; an assistant message split over rows of one `message.id` is all of them, in order; adjacent
   `user` rows, such as a Skill tool result and the skill text after it, are one message; a string prompt is one
   text block). `fixtures.test.ts` checks that every tail and shape hash resolves by these rules. When a placeholder changes a message or a shape, the normaliser recomputes its hash
   and rewrites every `tail` and `shapeHash` that pointed at it. `requestDigest` hashes the full wire request,
   which the log does not hold exactly; it stays as recorded and is an opaque id. Tail hashes that match no
   message are counted in `manifest.json` (`unresolvedTailHashes`) and the script warns.
   Usage numbers are never touched: they are the exact counts of what was sent, before normalisation.
3. **Scans** every file with the personal-data patterns of `scripts/lib/personal-data.ts`, this checkout's git
   email and host name, the values of the secret variables (`AWS_BEARER_TOKEN_BEDROCK`, `ANTHROPIC_API_KEY`,
   `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`), and **canary terms** from your real config folder
   (`$CLAUDE_CONFIG_DIR` or `~/.claude`; `tools/canary.ts`): each long line of `CLAUDE.md`; the names and
   descriptions of your skills, agents and commands; your plugins and own marketplaces; your MCP servers (also from
   `~/.claude.json`); the script names in your hooks; plus `QX_CANARY_TERMS` (comma-separated) and your home path.
   Built-in skill and agent names are skipped, and one-word names are looked for in their listing form
   (`- name:`), because they are often ordinary words. These terms are read at run time and never stored. A
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
- `@notes.txt` in a prompt gives an `attachment` row (`type: file`); the call sends it as two reminder texts, a
  Read call and its result. A Skill tool call gives a `tool_result` row and a meta `user` row with the skill
  text; the API receives both as one message.
- Subagent calls are in their own transcript, with `agentId` on each `api-request` and `querySource`
  `agent:builtin:<type>`.

## Notes for the adapter (build step 3)

- **Compaction usage is derived, not exact.** The summarising call of a compaction has no `api-request` or
  `assistant` row, so its usage is not in the log. It can be derived as the change of the cumulative
  `cost-state.modelUsage` (per model) from the last `cost-state` row before the `compact_boundary` to the first
  after it, minus the usage of calls logged in between. Mark it as derived, and check it against
  `compactMetadata.preTokens` (the context before) and `postTokens` (after). `manifest.json` records this per
  compaction (`compactions`, from `compactionsOf` in `tools/manifest.ts`).
- **Model ids differ by place.** Bedrock ids are kept as recorded: `params.model` is the requested id with a
  region prefix and version suffix (`eu.anthropic.claude-sonnet-4-5-20250929-v1:0`), `message.model` is the
  canonical name (`claude-sonnet-4-5-20250929`), and `cost-state.modelUsage` is keyed by the requested id. Other
  setups add a `[1m]` suffix for the 1M context. Match them by a normalised id.
- **Usage repeats over rows.** One API message is written as one `assistant` row per content block, and each row
  carries the same `message.usage`. Count usage once per `message.id`.
- **Parameters vary per call.** Opus 5.5 sends adaptive thinking and `output_config.effort`; Sonnet 4.5 sends
  `thinking: { type: "enabled", budget_tokens }` and no effort.
- `osVersion` and the platform in the environment reminder are kept as recorded (`darwin`).

## Ground truth for estimates (not yet)

Per-block token counts would need the free token-counting endpoint (Bedrock `CountTokens` or Anthropic
`count_tokens`) run on single fixture blocks, with the same isolated auth as `record.ts`. With the Bedrock API key
used for the 2.1.322 recording this is not possible: the key's IAM policy does not allow `bedrock:CountTokens`.
Until a key with that permission (or an `ANTHROPIC_API_KEY`) is available, block splits stay estimates reconciled
to exact totals, and the estimator error is measured only against exact per-call changes.
