# 20. Store schema v1, revised: classification per log, adapter version, content without copies

Status: accepted (revises ADR 19; schema v1 is not released yet, so it is changed in place)

## Context

A read-only run over the real corpus (1.18 GB) after ADR 19 showed:

- Blocks kept the kind and source of the first log that reported them, so a fix to the classifier never reached
  stored Blocks, and the stored graph of a log could depend on which log was read first.
- Snapshots carried no adapter version: a new adapter went on from a snapshot of an old one.
- 730 MB of database: display text (79 MB) repeated content, tool input (26 MB) repeated the tool use Block,
  base64 images were text in content, and the open-runs index was as large as the interval index.

## Decision

- **An adapter version per log.** `logs.adapter_version` is the codec's `version` (`ADAPTER_VERSION` in the
  Claude Code adapter, now 2). A log of another version is emptied when it is opened, so ingest reads it again
  from the start. The parser refuses a snapshot of another `ParserState` version.
- **Classification per log.** `blocks` holds only `(hash, content)`; `log_blocks (log, hash, kind, tool,
  file_path, mcp_server, skill)` holds each log's own kind and source. Content stays stored once.
- **No stored display text.** `StoreCodec.text(content)` gives it at read time, as the adapter does.
- **Media apart.** Canonical base64 data of 128 characters or more (images, documents) is stored decoded, once,
  in `media (hash, media_type, bytes)`; the content keeps `{"$media": hash}` in its place.
- **Tool input by reference.** `tool_calls.block_hash` names the tool use Block; `input` is NULL when that
  Block holds it.
- **Runs keyed by their interval.** `call_blocks` has the primary key `(log, session_id, lane, first_call,
  position)`: one Block per position per Call is a domain rule, and the run's id is made of these parts. The key
  serves "context at call N" and the open runs of a lane; there is no other interval index.
- **`WITHOUT ROWID`** for every table with a natural key, except `blocks` and `media` (large rows).
- New in the schema: `sessions.request_log`, `title`, `title_source`, `agent_name`; `calls.turn_duration_ms`;
  `session_events`; `report_kinds` (unknown and ignored record kinds); `scan_issues`.
- Hashes stay hex text, so that agents can read and paste them in `qx sql`. Binary hashes would save about a
  third of the key space; that is a later option.

## Consequences

- On the real corpus: 520 MB of database for 1.18 GB of transcripts (was 730 MB), 30 s on Node, 23 s on Bun.
- Reading a Block needs the codec (for its text and media): the query layer gets it from the composition root.
- Bumping `ADAPTER_VERSION` re-reads every log on the next start: bump it only when stored rows would change.
