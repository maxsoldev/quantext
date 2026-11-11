# 1. One harness-neutral domain model

Status: accepted

## Context

Quantext reads Claude Code first, and Codex later. Each harness writes its logs in its own row types and shapes. If
these shapes leak into the store, the queries or the viewer, each new harness changes every layer.

## Decision

Only `adapters/` knows a harness's row names and shapes. An adapter turns them into domain events: `Session`, `Call`,
`Block`, `CallBlock`, `ToolCall`, `Compaction` (see `docs/GLOSSARY.md`). All layers above speak only this model. The
layer check enforces that only `ingest` imports `adapters`, and that `adapters` imports only types from `core`.

## Consequences

- A new harness is a new adapter, not a change to core, store, query or the surfaces.
- Until the Codex spike (build step 4), the model is kept neutral by review. The spike may still change core types.
- Harness-specific details that the model cannot express are reported as unknown, not stored in ad-hoc fields.
