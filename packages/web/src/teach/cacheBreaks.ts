/**
 * Why the cache read dropped, in plain words: a short line for tooltips, what happened, and what to do about it.
 * Prices: a cache read is 0.05× to 0.1× of the input price (by model), a write 1.25× (5 min) or 2× (1 h).
 */
import type { CacheBreakReason } from "@quantext/shared";

export interface BreakReason {
  title: string;
  /** One line, for the timeline's tooltip. */
  short: string;
  what: string;
  todo: string;
}

export const BREAK_REASONS: Record<CacheBreakReason, BreakReason> = {
  compaction: {
    title: "Compaction",
    short: "A compaction replaced the conversation with a summary, so the cached messages no longer match.",
    what:
      "The harness replaced the conversation with a short summary. The tool schemas and the system prompt at the " +
      "start did not change, so they were still read from the cache. Everything after them is new and was written " +
      "to the cache again.",
    todo:
      "This is expected once per compaction. Compact at a natural break (for example after a task) instead of in " +
      "the middle of one, and keep the start of the request stable so that it stays cached.",
  },
  "model-switch": {
    title: "Model switch",
    short: "This call ran on another model: each model has its own cache.",
    what:
      "This call ran on a different model than the call before it. Each model has its own cache, so nothing the " +
      "other model cached could be read. The whole input was processed and written to the cache again.",
    todo:
      "A switch in the middle of a session pays for the whole context again. Stay on one model in a session, or " +
      "switch at the start of a new one.",
  },
  ttl: {
    title: "Cache expired",
    short: "More time passed than the cache lives (5 min, or 1 h when the harness asks for it).",
    what:
      "More time passed since the call before than a cache entry lives: 5 minutes, or 1 hour when the harness asks " +
      "for it. Each read starts the clock again, so the cache stays warm only while calls keep coming. After the " +
      "pause, the provider processed the whole prefix again and wrote it to the cache.",
    todo:
      "A long pause costs one full write of the context: 1.25× the input price for a 5-minute entry, 2× for a " +
      "1-hour one. The larger the context, the more a pause costs. Before a long break, compact or start a new session.",
  },
  "prefix-change": {
    title: "Prefix change",
    short: "Something early in the request changed, so the cache matched only up to there.",
    what:
      "Something early in the request changed: a tool was added or removed (an MCP server that connected), the " +
      "system prompt changed, the context injected into the first message changed (an edited CLAUDE.md, the " +
      "date), or an earlier message was edited. The cache matches a " +
      "request only from its start up to the first difference, so everything after it was written again.",
    todo:
      "Look at the first change below: that block broke the cache. Keep the start of the request stable: do not " +
      "change tools, MCP servers or CLAUDE.md in the middle of a session.",
  },
};
