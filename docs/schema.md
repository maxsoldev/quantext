# Store schema (version 1)

The engine keeps everything in one SQLite database, `~/.quantext/quantext.db` (WAL mode). Only the engine writes
it, under the writer lock `~/.quantext/writer.lock` (an OS file lock, ADR 22). The decisions behind this schema
are in ADR 19 and ADR 20; the domain terms are in `GLOSSARY.md`. This file is the reference for the query layer, its SQL views, and agents that use
`qx sql`.

## Conventions

- **Every domain row belongs to a log.** A log is one main transcript and its subagent transcripts. Keys are
  `(log, id)`, because the same domain id can occur in two logs (a session that went on in another project
  folder). Join tables on `log` as well as on the id.
- **NULL means absent.** A NULL column is an optional field the adapter did not set (no usage yet, no cost, an
  open run).
- **JSON columns are text.** Read them with `json_each` and `->>`.
- **Positions and indexes are 0-based.** `calls.idx` is the Call's position in its Session.
- **Hashes are hex text**, so that they can be read and pasted (binary hashes: see "Later").
- **Tables with a natural key have no rowid** (`WITHOUT ROWID`); only `blocks` and `media` keep one.

## Tables

### `schema_version`

One row: `version`, the schema version of the database.

### `logs`

| Column | Meaning |
|---|---|
| `id` | The log's key, used by every other table |
| `path` | The path of the main transcript |
| `harness` | `claude-code` |
| `adapter_version` | The adapter version that wrote the log; a log of another version is emptied and read again |
| `snapshot` | The parser's snapshot after the last write (JSON): the open frontier only |

### `ingest_files`

One row per file of a log that ingest has looked at.

| Column | Meaning |
|---|---|
| `path` | The file's path (primary key) |
| `log` | Its log |
| `transcript` | The name the parser knows it by: `main`, or the subagent's file name without `.jsonl` |
| `kind` | `transcript` or `meta` (a subagent's `.meta.json`) |
| `file_id` | `device:inode`; another value at the same path means the file was replaced |
| `size`, `mtime_ms` | As last seen |
| `byte_offset` | Bytes read: up to the end of the last complete line. `size - byte_offset` bytes wait for a newline. While a read is not at the end of the file yet, `size` is `byte_offset` |
| `fingerprint` | A hash of the first 4 KiB and of the 1 KiB before `byte_offset`, to see a file rewritten in place |
| `error` | Why the file could not be read the last time, else NULL |

### `sessions`

`log`, `id`, `parent_id` (the Session that started a subagent), `harness`, `harness_version`, `project`, `cwd`,
`started`, `ended` (ISO 8601), `request_log` (`present`: every Call's request is logged; `absent`: the harness
version logs only usage, so its Calls are usage-only and have no Blocks; `partial`: both), `title` and
`title_source` (`user`: the user's own title; `harness`: one the harness made), `agent_name`.

### `calls`

| Column | Meaning |
|---|---|
| `log`, `id`, `session_id` | The Call and its Session |
| `idx` | 0-based position in the Session |
| `lane` | The lane: Calls that build on each other's context (one model, one purpose) |
| `ts`, `model`, `canonical_model` | Time; the model id as requested, and as priced (NULL when unknown) |
| `params` | JSON: max tokens, effort, reasoning, provider-only parameters |
| `shape_hash` | The Shape of the request |
| `usage_basis` | `exact` or `derived`; NULL when the log has no usage for the Call |
| `input_tokens`, `cache_read_tokens`, `cache_write_tokens` | The input side of Usage; the three add up to the input total |
| `cache_write_5m_tokens`, `cache_write_1h_tokens` | The cache write by time to live, when reported |
| `output_tokens`, `reasoning_output_tokens` | Output, and its reasoning part when reported |
| `speed`, `service_tier`, `inference_geo` | How the provider served the Call |
| `cost_input_usd`, `cost_cache_read_usd`, `cost_cache_write_usd`, `cost_output_usd`, `cost_total_usd` | Cost by part; NULL without a price |
| `price_model`, `price_source`, `price_date`, `price_modifiers` | The price list entry used; modifiers as a JSON list |
| `block_count` | Blocks in the input, once the request is split; NULL for a Call that was not split |
| `cache_breakpoints` | JSON list of the positions that carry a cache breakpoint |
| `cache_boundary_tokens`, `cache_boundary_position` | The Cached prefix: cache read tokens, and the number of leading Blocks wholly inside it |
| `framing_tokens` | Input tokens after the last Block; the Call's runs plus these add up to its input total |
| `issues` | JSON list of `{kind, detail}`, sorted by kind and detail: `no-request` (a usage-only Call), `missing-message` (a gap Block stands for a message, or the message came after the Call was split), `derived-usage-invalid` (a summarising Call whose derived input is 0 or less: it has no usage), `unresolved-request`, `no-usage`, `unreconciled-tokens`, `no-price`, `price-assumption`, `estimate-clamped` |
| `turn_duration_ms` | On the last Call of a turn: how long the turn took |

### `blocks`

One row per unique content block, for all logs: `hash` (the Block hash) and `content` (the content block as sent
to the provider, JSON). Long base64 data in it (images, documents) is replaced by `{"$media": "<hash>"}`, and
its bytes are in `media`. A content block that no Call has used yet is only here, not in `log_blocks`.

### `media`

`hash` (sha256 of the bytes), `media_type`, `bytes` (BLOB, decoded): each image or document once, for all logs.

### `log_blocks`

The Blocks a log reported, with that log's classification: `(log, hash)`, `kind` (the Block kind, also `gap`:
a stand-in for a message that is not in the log), and the Block source `tool`, `file_path`, `mcp_server`,
`skill`, `attachment` (the kind of context the harness attached, in its own words, when an attachment row
rendered exactly this text: `file`, `skill_listing`, `session_context`, …). The display text of a Block is not
stored: the engine derives it from the content.

### `call_blocks`

One row per CallBlock run: one Block at one position over consecutive Calls of one lane, with the same tokens.
The primary key is `(log, session_id, lane, first_call, position)`: there is one Block per position per Call.

| Column | Meaning |
|---|---|
| `log`, `id`, `session_id`, `lane` | The run, its Session and lane |
| `block_hash` | The Block |
| `position` | 0-based position in the input: tool schemas, then system blocks, then messages |
| `section` | `tools`, `system` or `messages` |
| `message` | The index of the message that holds the Block (messages section) |
| `tokens`, `basis` | The Block's share of each Call's input; `exact`, `derived`, `anchored` or `estimate` |
| `grp` | Blocks of one group were split from one exact total: their tokens add up to it |
| `first_call`, `last_call` | The `calls.idx` range; `last_call` is NULL while the run goes on to the lane's latest Call |

The Blocks of Call N, in order, are one range lookup on that key:

```sql
SELECT r.position, r.tokens, r.basis, b.kind, b.tool, c.content
FROM call_blocks r
JOIN log_blocks b ON b.log = r.log AND b.hash = r.block_hash
JOIN blocks c ON c.hash = r.block_hash
WHERE r.log = :log AND r.session_id = :session AND r.lane = :lane
  AND r.first_call <= :idx AND (r.last_call IS NULL OR r.last_call >= :idx)
ORDER BY r.position;
```

Use it only for a Call with `block_count` not NULL. The lifetime cost of a Block in tokens is the sum, over its
runs, of `tokens` times the number of Calls of the lane in `[first_call, last_call]` (the lane's latest index
for an open run).

### `tool_calls`

`log`, `id` (the tool use id), `session_id`, `call_id` (the Call whose response holds the tool use, or the
usage-only Call), `name`, `input` (JSON; NULL when the tool use Block holds it), `block_hash` (the tool use Block:
its content's `input` is the input), the source columns `tool`, `file_path`, `mcp_server`, `skill`, `result_block_hash` (the Block that
holds the result), `is_error` (0 or 1), `duration_ms`, `parallel` (tool uses in the same response),
`child_session_id` (the Session a subagent tool started).

### `compactions`

`log`, `id`, `session_id`, `ts`, `trigger` (`manual`, `auto`), `before_tokens`, `after_tokens`,
`before_call_id` (the last Call before), `summary_call_id` (the Call that wrote the summary).

### `session_events`

A Session's timeline besides its Calls: `(log, id)`, `session_id`, `ts` (a row without a time gets the time of
the latest row before it), `kind`, `value` and `detail` (JSON):

| `kind` | `value` | `detail` |
|---|---|---|
| `mode` | the permission mode | |
| `cwd` | the folder the Session moved to | |
| `note` | a summary the harness wrote (for example while the user was away) | |
| `pr` | the pull request's URL | `number`, `repository` |
| `continued-in` | the Session it went on in | |
| `forked-from` | the Session whose context it started from | `contextLength`, `parentLastUuid` |

### `messages`, `shapes`, `records`

The adapter's own data, kept so that a parser restored from its snapshot can look it up (ADR 18). Not for
reports: use the domain tables.

- `messages`: `(log, key)`, `role`, `blocks`: one Blob as a JSON list of Block hashes, in order.
- `shapes`: `(log, key)`, `tools`, `system`: JSON lists of Block hashes.
- `records`: `(log, key)`, `value`: any other record, as JSON.

### `report_kinds`, `report_unreadable`, `scan_issues`

What could not be mapped or read, so that nothing is dropped in silence.

- `report_kinds`: `(log, status, kind)`, `count`, `seq` (the order first seen). `status` is `unknown` (a record
  type the adapter does not know, such as a new row type) or `ignored` (a known type that holds nothing for the
  domain, such as UI state).
- `report_unreadable`: `(log, seq)`, `at` (`<transcript>:<line>`, `<transcript>.meta`, or `<transcript>@<byte>`
  for a line longer than the limit), `reason`.
- `scan_issues`: `path`, `issue`: what the last full scan of the transcript folder could not read (folders) or
  did not follow (symbolic links).

File errors are in `ingest_files.error`.

## Later

Options that are not needed yet, with what they would bring:

- **Binary hashes** (BLOB of 32 bytes instead of 64 hex characters) would save about a third of the key space of
  `blocks`, `log_blocks`, `call_blocks` and `messages`. Hex text stays while agents read hashes in `qx sql`.
- **A lanes table with integer ids** (N5): `call_blocks` and `calls` repeat the lane key (`model|query source`)
  and the session id in every row; an integer lane id would make their keys several times smaller.
- **Peak memory of a full import on Bun** (N4): about 800–900 MB for the 1.2 GB real corpus (Node: about
  750 MB). Ingest memory is bounded per batch; the rest is the runtime's heap growth. Watch it when the corpus
  grows; a smaller `restoreBytes` lowers it at some cost in time.

## Changing the schema

Add a migration in `packages/engine/src/store/schema.ts`; never edit a released one. Update this file and, when
the change is hard to undo, write an ADR.
