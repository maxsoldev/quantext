# 14. Domain and API types live in @quantext/shared

Status: accepted

## Context

The engine, the viewer and the mod all speak the domain model (`Session`, `Call`, `Block`, `CallBlock`, `ToolCall`,
`Compaction`) and the API types. The mod sandbox accepts only erased type imports from our code. If the domain types
lived in engine `core`, the viewer and the mod would have to import the engine, or copy the types.

## Decision

The domain types and the API types live in `@quantext/shared`, a package with no runtime code. `core` holds the
logic over these types (context rebuild, token attribution, pricing) and may import only types from shared
(`import type`); every other import outside core stays forbidden. Every other engine layer, the viewer and the mod
may also import types from shared. The layer check enforces this (ADR 10).

## Consequences

- One definition of each type for engine, viewer and mod; no generated clients.
- A value (a constant, a function) can never move into shared; it belongs in core or in the package that uses it.
- Changing a domain type is a change to the shared package, visible to every consumer at type-check time.
