# 16. A providers layer for what a model provider defines

Status: accepted

## Context

Build step 3 put Anthropic knowledge into core: the content block types (`tool_use`, `tool_reference`,
`defer_loading`, thinking), the image token formula (width x height / 750, long edge at most 1568 px) and the
Anthropic price list. That knowledge belongs to the model provider, not to the harness and not to the generic
logic. Claude Code can run on Anthropic models through several clouds; Codex runs on OpenAI models. A harness
(adapter) and a model provider are separate axes.

## Decision

A new engine layer, `providers/`, sits between core and adapters. `providers/anthropic` holds Anthropic content
blocks, their estimates and text, the thinking rules, and the price table with its modifiers (Bedrock regional
endpoints, fast mode, US-only inference, Haiku 5.5's prompt-size tier). core keeps what is the same for every
provider: reconciliation, anchors, attribution, the estimator interface and the price-sheet arithmetic.

Like core, providers are pure: no built-ins, no packages. providers import core and shared types; adapters,
ingest and cli may import providers; store, query and api may not.

## Consequences

- A new provider is a new folder under `providers/`, with no change to core.
- An adapter picks the provider for its calls (the Claude Code adapter uses `providers/anthropic`).
- The layer check (`scripts/lib/layers.ts`) and its tests hold the rule; ADR 10 lists it.
