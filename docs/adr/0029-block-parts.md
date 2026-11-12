# 29. Parts of a Block: attached texts merged into one content block

Status: accepted

## Context

Claude Code logs one `attachment` row per text it adds to a request (environment, skill listing, deferred tools,
MCP instructions, agent listing, date, …), but it sends several of them as one text block: the texts without
their `<system-reminder>` wrapper, joined by blank lines (5–7k tokens on the fixtures, 18k characters and nine
kinds on a real session). The adapter gave a Block an attachment source only when its text was exactly one
attachment's text, so these Blocks had no source, and the skill listing or the deferred tools list could not be
seen as such.

## Decision

- **Parts are child entities of a Block, not Blocks.** `Block.parts?: BlockPart[]`, each `{start, end, label,
  source}`: spans of the Block's display text that cover it end to end, in order. A Block stays one content block
  of the request, so positions, hashes, cache breakpoint paths, CallBlock runs, the cached prefix and the diff do
  not change, and the request still rebuilds byte for byte from the Block's content.
- **Stored with the log's classification:** `log_blocks.parts` (JSON, schema 5), because which attachments a text
  holds is what one log tells about it, as `attachment` already is. The context query reads it in the join it
  already makes: no new table, no extra lookup.
- **Tokens are not stored per part.** The query splits each CallBlock's tokens over its parts in proportion to
  their characters, reconciled to add up exactly to the Block's tokens (`reconcile`, basis `estimate`).
- **Matching, in the adapter only:** each rendered text of an attachment row (as logged, else without its
  wrapper) is looked for as a substring, in row order, each at its first place not yet taken. Blank space between
  spans joins the span before it; other text no attachment accounts for is a part labelled "Other text" with no
  source. Nothing is guessed from separators. One attached text that is all of a Block still gives the Block its
  source, as before, now with one part. The label ("Skill listing", "Deferred tools", …) comes from the adapter,
  so no layer above it knows Claude Code's attachment names.
- **An attached text that no message of the next request holds** gets an `unlocated-attachment` issue on that
  Call. A Call with a missing message blames none; nor is an attachment flagged that a newer one of its type
  replaced before the request (the harness sends the newest). Claude Code logs many `total_tokens_reminder` rows
  that it never sends (their text is in no message of the log): those are counted in the ingest report as
  ignored (`attachment total_tokens_reminder (not sent)`), not flagged on each Call.
- The parser keeps the attached texts in its snapshot, newest last, at most 64 and 256 KiB of characters: the
  same text may be sent again in a later Block.

Rejected: a Block per attached text in the request order. It breaks the rule that a Block is one content block
(the rebuild would have to join Blocks again), multiplies CallBlock runs by the number of parts, and moves the
cached prefix and cache breakpoints off content-block boundaries.

## Consequences

- `ADAPTER_VERSION` 9: stored logs are read again. Parser state version 5.
- The context of a Call lists each Block's parts with estimated tokens; the category totals do not change.
- A text that a user types and that is equal to an attached text would be labelled as that attachment.
- On a real corpus (about 29k Calls), 107 Calls in 30 logs keep an `unlocated-attachment` issue. Harness notices
  that come from no attachment row stay unlabelled reminders.
