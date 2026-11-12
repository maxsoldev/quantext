# 18. The parser snapshot holds only the open frontier; old content comes from a lookup

Status: accepted

## Context

The incremental parser of ADR 17 kept the whole session in its state: every message, shape, request, Call and
ToolCall. Its snapshot grew with the session (9.8 MB for a 2000-call session), and live tailing spent most of its
time writing snapshots. The store (build step 5) keeps all of that content anyway, from the deltas.

## Decision

- `snapshot()` holds only the open frontier: the partial last line and the current run of user rows of each
  transcript, Calls that wait for a response or for a missing part of their request, the latest split Call of
  each lane (its request and response), open ToolCalls and compactions, and running usage sums instead of lists
  of Calls. Lanes are kept as headers: their layout is the lane's open runs.
- Each delta carries `records` (`AdapterRecord`: key and JSON value): the adapter's own data, such as messages,
  shapes and requests in Claude Code. The caller keeps them.
- `createClaudeCodeParser(state, { lookup })` takes a `ContentLookup` (in `@quantext/shared`): records, Blocks,
  Calls, ToolCalls and the open runs of a lane, as the caller kept them. The parser asks it only for what its
  frontier no longer holds; a restored lane rebuilds its layout from the open runs on first use.
- A request whose base is the latest Call of any lane takes that lane's message list; only an older base is
  walked back along the requests, once, in linear time.

## Consequences

- The snapshot of a growing synthetic session stays at about 4 kB from 500 to 5000 calls (test: under 200 kB).
- Tests implement the lookup over an in-memory store; a property test restores from JSON snapshots at random
  points of every fixture and gets the same graph as one read.
- The store answers the lookup from its tables; it must apply each delta before the next read.
- After a restore, an estimate is taken again from the Block's content, so a fallback split may differ slightly
  from one without a restore (no fixture needs a fallback).
