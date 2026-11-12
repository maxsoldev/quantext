# 6. Exact usage first; estimates must reconcile

Status: accepted

## Context

The API reports exact token counts per call (`usage`: input, cache read, cache write, output). It does not report
tokens per block. A tokenizer estimate per block is useful but can be wrong, and wrong numbers are worse than none
when we teach context engineering.

## Decision

Totals per call come only from `usage`. To split a total into blocks, we first use exact deltas between calls; only
the rest is split with estimates. Every block number carries its token basis (`exact` or `estimate`). The blocks of a
call must add up to the exact total; when they do not, the call is flagged and the gap is shown.

## Consequences

- Every number in the viewer shows its basis and links to the calls it comes from.
- Estimates only split the part of a total that exact deltas do not explain. A single estimate can be wrong; the sum cannot.
- A call without `usage` has no exact total; it is reported, not filled in.
