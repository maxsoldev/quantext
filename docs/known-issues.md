# Known issues

Issues we know about and chose to defer. Each one is recorded here, not fixed in passing: fix critical and high
issues at once, and add the rest to this table. When you fix one, remove its row in the same commit.

Severity: **high** (wrong numbers or lost data in normal use), **medium** (wrong or slow in some cases, with a
workaround), **low** (cosmetic, rare, or only a cost).

| Severity | Area | Issue | Proposed fix |
|---|---|---|---|
| medium | adapter | On the real corpus, about 10 Calls get the issue "blocks kept from the previous call have N tokens, more than N" (`core/attribute.ts`). The cause is not known; it is not caused by compaction. | Make a fixture that shows it (or a minimal synthetic case), then find which Blocks are counted as kept but are not. |
| medium | adapter | Token basis has no ground truth: exact and derived per-Block counts are not checked against the provider. Bedrock `CountTokens` (checked 2026-11-12) works for Sonnet 4.5 and Haiku 4.5, but answers "The provided model doesn't support counting tokens" for Opus 5.5 (base id, `us.`, `eu.` and `global.` profiles) and for every `eu.` profile. | Add a `fixtures/tools` count-tokens script: Bedrock CountTokens for the Sonnet and Haiku fixture calls, and the Anthropic API `count_tokens` endpoint (needs a direct API key) for Opus. Check the estimates and anchored counts against it. |
| low | adapter | 3 Calls on the real corpus have input 0 on every row of their usage. | Look at the raw rows; if the harness logs no usage there, mark the Call as having no usage instead of zero. |
| low | adapter | The last Call of a Session with a missing message stays waiting, so it is never split into Blocks: no later request moves the log on (ADR 21). | Stop waiting at the end of the file when the Session has ended (idle for a set time), and split with gap Blocks. |
| low | adapter | The first Opus Calls of a Session have about 2.5k input tokens that no Block explains. This is content the provider adds and does not log; Opus also adds a 286-token tool-use system prompt. | Model the known provider additions as a framing Block per model; keep the rest as framing. |
| medium | pricing | The long-context price (`[1m]` models, prompts over 200K tokens) is not verified; such Calls get an issue (`providers/anthropic/pricing.ts`). | Verify against the provider's price list and a billed Call, then set `longContextVerified`. |
| medium | store | On Bun, a full import of the 1.2 GB real corpus peaks at about 900 MB RSS (Node: about 750 MB). | Profile the heap on Bun; try a smaller `restoreBytes` (`docs/schema.md`, "Later"). |
| low | store | `call_blocks` and `calls` repeat the lane key and session id in every row, so their indexes are large. | A `lanes` table with integer ids (`docs/schema.md`, "Later"). |
| low | store | Hashes are 64-character hex text. | Binary hashes (32-byte BLOBs) once agents no longer read hashes in `qx sql` (`docs/schema.md`, "Later"). |
| low | store | Blocks and media that no log references any more are not deleted (no garbage collection), so the store only grows. | A compaction pass in the engine, after a log is removed or read again, that deletes unreferenced rows. |
| low | store | A final line with no newline is never read: ingest waits for the newline of a line that may still be written. `qx report` shows these bytes as pending. | Read a final line without newline once the file has not changed for a set time and it parses as complete JSON. |
| low | api | On Bun, a socket that sends nothing is not counted against the connection limit (64) before its first request, because Bun's `node:http` shows it only then. Bun closes such a socket by itself after about 10 to 12 s. | Count sockets at the `net` level on Bun, or accept it (the server is localhost only). |
| medium | query | `qx sql` has no SQLite authorizer on Bun (`bun:sqlite` has none). The read-only open, `query_only` and the statement text check still apply (`docs/schema.md`). | Use the authorizer when Bun adds one; until then the text check is the second guard. |
| low | query | The whole-corpus lifetime views (`v_block_lifetime_cost`, `v_tool_outputs`) take about 1.7 s on a 1.2 GB corpus (ADR 23). | Use the per-Session methods (`blockLifetimes`, `toolOutputs`, `qx outputs`, `qx blocks`); document it in the agent skill. |
| medium | viewer | A Call with no usage draws nothing on the timeline: a white gap with no mark or explanation (seen on the real corpus). | Draw a muted placeholder column for such Calls, with "no usage in the log" in the tooltip. |
| medium | viewer | The session list reads its whole loaded range again (pages of 500) on each change event, at most once a second. With thousands of Sessions this is many requests during a live session. | Read `/api/v1/sessions?changedSince=<cursor>` and merge the changed rows into the list. |
| medium | viewer | No React error boundary: an error while rendering blanks the page. | An error boundary per page that shows the error and a link back to the session list. |
| low | viewer | A stream opened with no cursor asks the pages to read again once it is ready, so each page reads its data twice on load. | Open the first stream with the cursor of the first `/api/v1/sessions` page, as `docs/api.md` suggests, and skip the refresh. |
| low | viewer | The billing panel of the timeline shows the input's shares (cache read, cache write, uncached); output tokens are only in the tooltip. | A thin output strip under the panel, on its own scale, if teaching needs it. |
| low | viewer | Issue kinds show as their API names (`estimate-clamped`, `unresolved-request`) in the session list's tooltip. | Words and an explanation per kind, with the glossary panel (step 8 part 2). |
| low | viewer | The saved dark or light theme shows after the first paint (no inline script under the CSP), so a page can flash in the OS theme. | Accept, or keep the theme in a cookie the engine reads to set `data-theme` on `<html>`. |
| low | viewer | Some Calls have an empty model id, so their lane shows as "Unknown model". | Find why the adapter gives no model for those Calls (side queries?) and name the lane by its purpose. |
| low | viewer | The e2e tests run only in Chromium. | Add a WebKit project to `playwright.config.ts` (Safari has the Web Locks and BroadcastChannel APIs). |
| low | process | Commits `c930dcf`, `9189781` and `0614d34` do not pass `pnpm check` alone (the history is append-only, so they stay). Two commits were amended or squashed before they were pushed, to keep the personal-data history scan green. | None: keep to one green commit at a time. A bisect may need to skip those three. |
