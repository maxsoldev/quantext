# 15. Tokens belong to the CallBlock; the end of a request is framing

Status: accepted; CallBlocks became runs in ADR 17

## Context

The first domain model gave each `Block` one token count. But the same content has a different count under a
different tokenizer: the 2.1.322 fixtures switch from Opus 5.5 to Sonnet 4.5 in one session (`effort`), and the
tokenizer of Opus 4.7 and later counts the same text as up to about 1.35 times the tokens of the older one. A Block also gets its number by splitting a Call's exact total
(ADR 6), so the number depends on that Call.

The provider reports how many input tokens follow the last cache breakpoint (`input_tokens`). When the last Block
carries that breakpoint, these tokens are the end of the request (2 to 10 tokens in the fixtures) and belong to no
Block. Putting them on the last Block would make an exact number wrong.

## Decision

- `tokens` and `basis` are fields of `CallBlock`, not of `Block`. A Block kept from the previous Call of the same
  model keeps its tokens; across a model change the split starts again.
- `Call.framingTokens` holds the input tokens after the last Block when the cache split makes them known (else 0).
  The CallBlocks of a Call plus its framing tokens add up to its input total, exactly.

## Consequences

- Lifetime cost of a Block is a sum over its CallBlocks, as before.
- The store (build step 5) keeps tokens per CallBlock row.
- The exact change between two Calls is the tokens of the new Blocks, without the framing of either Call.
