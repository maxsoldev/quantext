// Proves the workspace link to @quantext/shared type checks; real imports replace it.
import type {} from "@quantext/shared";

/** Claude Code plugin. Runs in the mod sandbox: no DOM, no Node, imports only types from @quantext/shared. */
export {};
