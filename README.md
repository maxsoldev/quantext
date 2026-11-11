# Quantext

Quantext reads the session logs of coding agents (Claude Code first), rebuilds exactly what the model received on
every call, and shows where the context tokens go: in a live web viewer, in a status line inside the harness, and to
agents through SQL and a CLI. Nothing leaves the machine.

**Status: pre-release.** The repository holds the skeleton only. There is nothing to install yet.

- [Architecture](docs/ARCHITECTURE.md): layers, domain model, release plan, quality bar.
- [Glossary](docs/GLOSSARY.md) and [decision records](docs/adr/).
- [Working rules](AGENTS.md) for contributors and coding agents.

Licence: [Apache-2.0](LICENSE).
