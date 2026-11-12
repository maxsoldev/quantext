# Known issues

Medium and low problems found in release 1, each with a proposed fix.

## Mod

- **Bedrock regional cost is low by 10%.** The footer label shows the harness's own session cost
  (`session.measure`'s `cost.usd`). Claude Code prices a Bedrock regional model id (`eu.`, `us.`, `apac.` …) at the
  list price, but those endpoints cost 10% more for Claude 4.5 models and later (the engine's pricing applies it).
  Fix: multiply by 1.1 when `$.session.model()` is a regional Bedrock id of such a model, or show the engine's cost
  once it runs.
