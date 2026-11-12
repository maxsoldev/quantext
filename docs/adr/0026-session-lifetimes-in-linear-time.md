# 26. One Session's lifetimes in near-linear time, with the SQL view as their definition

Status: accepted

## Context

`blockLifetimes` and `toolOutputs` (ADR 23) ran `lifetimeSql`, which joins each CallBlock run with every Call it
covers: the work grows with runs × Calls (0.8 s at 2,000 Calls, 7 s at 6,000, about 20 s at 10,000), and the
viewer asks for it per Session.

## Decision

The query layer computes one Session's lifetimes in TypeScript (`query/lifetimes.ts`) from two indexed reads (its
Calls with their stored prices and boundary, its runs), in O((Calls + runs) · log Calls):

- the price as cache read over all Calls of a run comes from prefix sums over its lane;
- the Calls where a run lies after the cache boundary are summed with Fenwick trees: runs are taken by position,
  and each Call is added once its boundary is below that position; one range query per run;
- the Block at a Call's boundary is at most one run per Call: each such pair is found directly.

`lifetimeSql` stays: it is the definition, behind the views for `qx sql`, and a property test checks that both give
the same numbers on every fixture and on synthetic Sessions with scrambled prices, boundaries and tokens. Nothing
stored changes, so the schema stays at version 3.

## Consequences

- At 2,000 / 6,000 / 10,000 Calls: `blockLifetimes` 14 / 39 / 57 ms, `toolOutputs` 25 / 85 / 149 ms (guarded:
  under 1 s at 10,000).
- The whole-corpus views for agents are still the quadratic SQL; agents use `qx blocks` and `qx outputs` per
  Session.
