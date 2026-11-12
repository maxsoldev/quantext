# 19. Store schema v1: rows per log, content once, runs with an interval index

Status: accepted; revised by ADR 20 before release

## Context

Build step 5 stores what the adapter's deltas give (ADR 17, 18) so that the query layer, the viewer and agents
can read it, and so that ingest can go on from where it stopped. On the real corpus of one developer (about
1.2 GB in 560 files) three facts shaped the schema:

- Ids are not unique across files: 113 request ids, one session id and one subagent id occur in more than one
  file (a session continued in another project folder). A row keyed only by its domain id would mix two logs.
- Most input bytes repeat content: each message's content blocks come back in every later request. Stored
  as whole messages, content would be kept many times.
- Most CallBlock runs stay open: the latest Call of a lane holds most of its context.

## Decision

- **A log is the unit of ingest.** One main transcript and its subagent transcripts are one log (`logs`), read by
  one parser whose snapshot is kept on the log. Every row of the domain (sessions, calls, call_blocks,
  tool_calls, compactions) and of the adapter (messages, shapes, records) has the log in its key:
  `(log, id)`. Deleting a log deletes all of its rows by `ON DELETE CASCADE`, in one transaction.
- **Content is stored once.** `blocks` is keyed by Block hash only, for all logs. A message (Blob) and a Shape are
  lists of Block hashes; the adapter's `RecordCodec` maps its records to these lists and back. A content block
  that no Call has used yet is a `blocks` row with no kind. `log_blocks` says which Blocks a log reported, so
  each log reads back exactly its own graph, also after it is read again.
- **The first classification of a Block stays.** Two logs that hold the same content get one row; its kind and
  source are those of the log that reported it first.
- **Runs are rows with `last_call` NULL while open.** `call_blocks_interval` on `(log, session_id, lane,
  first_call, last_call)` serves "context at call N" and the parser's open runs. There is no partial index
  for open runs: on the real corpus it was as large as the full index.
- **Typed columns for what agents filter and sum; JSON for small nested values.** Usage, cost by part, price,
  cache boundary, Block source and ToolCall fields are columns; `params`, `issues`, `cache_breakpoints`,
  `price_modifiers`, tool input and content are JSON text. A NULL column is an absent optional field. Tables
  are `STRICT`.
- **Read positions are rows.** `ingest_files` keeps, per file, the device and inode, size, mtime, the byte
  offset after the last complete line, a fingerprint of the bytes around it, and the last read error.
- **Forward-only migrations.** `schema_version` holds one number; migration N takes version N - 1 to N, one
  transaction each. A database from a newer engine is refused, not changed.

## Consequences

- `docs/schema.md` documents the tables for the query layer and for `qx sql` (build step 6).
- Query by domain id must name the log (or accept more than one row) where ids repeat across logs.
- Blocks no log names any more stay in `blocks` after a log is read again; a later migration or a vacuum
  command can remove them.
- On the real corpus the database is about 60 % of the input size; unique content is 375 MB of it, the display
  text of Blocks 80 MB.
