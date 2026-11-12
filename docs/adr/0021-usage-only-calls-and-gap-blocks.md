# 21. Usage-only Calls, the request log of a Session, and gap Blocks

Status: accepted

## Context

On the real corpus, 87 sessions come from Claude Code versions that log no requests (no `api-request` rows,
no `requestRef`): their 6,560 responses were dropped in silence. And 66 Calls with one message missing from
the log made about 1,840 later Calls unresolved, because each Call waited for its base.

## Decision

- **A usage-only Call** for each response that names no request (by message id): exact usage, cost, model and
  time, no Blocks, flagged `no-request`. A reply the harness wrote itself (`<synthetic>`) is no Call.
- **`Session.requestLog`**: `present` (every Call's request is logged), `absent` (usage-only Calls only) or
  `partial` (both). The store's report counts sessions by it. The viewer shows cost and tokens for an absent
  log and says that its context cannot be rebuilt.
- **A gap Block for a missing message.** A Call that waits only for messages stops waiting when the log moves on
  (the next request in its lane, or one that builds on it, or 32 newer waiting Calls). It is then split with
  a gap Block (kind `gap`) in place of each missing message; the gap has no estimate, so it takes what the other
  new Blocks leave of the exact change. The Call is flagged `missing-message`; later Calls keep the gap and
  rebuild around it. A missing base or shape still makes a Call `unresolved-request`.
- Within one response, the first reported input side and the latest output side count; only a different
  input side after the split is flagged (later rows may report 0 input with a cache write split).

## Consequences

- On the real corpus, unresolved Calls fall from 1,909 to 17 (summarising Calls of compactions), and
  unreconciled ones from 3,986 to 14; 108 Calls are flagged `missing-message`.
- The last Call of a session with a missing message stays waiting (no later request moves the log on).
