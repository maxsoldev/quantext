# 17. CallBlocks are runs; adapters parse incrementally

Status: accepted

## Context

The first adapter wrote one CallBlock per Block and Call and split every Call from scratch. A tool loop of N calls
has about N²/2 such records: 1000 calls took 2.7 s and 710 MB, 2000 calls 10.5 s and 2.9 GB (synthetic session in
`packages/engine/test/adapters/claude-code/synthetic.ts`). Build step 5 also needs to parse a growing file without
reading it again.

## Decision

- A `CallBlock` is a run: one record while a Block stays at the same position with the same tokens, over the Calls
  of one lane (`firstCall`, `lastCall`, absent while open). The Call holds its own cache boundary (cache read tokens
  and the number of leading Blocks wholly inside it) and its breakpoint positions, so "in the cached prefix" is
  derived per Call. A Call that is not split (no usage, incomplete request) has no Blocks.
- A lane is the Calls of one Session with one model and query source. Each lane keeps the layout of its latest
  split Call; the next Call reuses the kept prefix (tokens, runs) and only classifies, estimates and attributes the
  new part. Messages and shapes are classified once per content.
- The Claude Code adapter is an incremental parser: `createClaudeCodeParser(state?)` with `push(text, transcript?)`,
  `pushMeta`, `flush` and `snapshot()`. Each push returns a delta of new and updated entities; later rows update
  earlier ones (a response, a tool result, a compaction's derived usage, a subagent link). A last line without a
  newline is held back. `snapshot()` is plain JSON. `parseClaudeCodeSession` is a thin wrapper.
- Shares split by estimate form a group whose sum is exact. Subtracting kept Blocks is exact only when every group
  among them is whole; otherwise the rest is an estimate too.

## Consequences

- 2000 calls parse in about 0.2 s and 40 MB; a performance test guards 1.5 s and 300 MB.
- A property test checks that reading every fixture in random pieces gives the same graph as one read, and that a
  parser restored from a JSON snapshot goes on to the same graph.
- The store (step 5) keeps runs and upserts them by id; the query layer lists the Blocks of a Call with
  `blocksAtCall` (core).
- Calls that branch from an older Call, or change their shape, cost time in proportion to their context once.
