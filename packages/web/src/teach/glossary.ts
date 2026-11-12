/**
 * The viewer's explainers: short, checked against docs/GLOSSARY.md and the provider's caching rules (reads 0.05× to
 * 0.1× of the input price by model, writes 1.25× for 5 min or 2× for 1 h, at most 4 breakpoints, order tools →
 * system → messages). Each names where the UI shows it.
 */
import type { CallIssue } from "@quantext/shared";
import type { SessionView } from "../route.ts";

export interface Where {
  label: string;
  /** A view of the session page to open first. */
  view?: SessionView | "context";
  /** The element to bring into view and point at. */
  selector?: string;
}

export interface Term {
  id: string;
  term: string;
  /** One sentence. */
  short: string;
  body: string;
  where?: Where;
}

export const TERMS: readonly Term[] = [
  {
    id: "context-window",
    term: "Context window",
    short: "Everything the model receives in one call, and the limit on its size.",
    body:
      "The model keeps no memory between calls. On every call the harness sends it all again: the tool schemas, " +
      "the system prompt, the context it injects and the whole conversation so far. The context window is the most the model can take in " +
      "one call (200k or 1M tokens, by model). When the conversation gets close to it, the harness compacts it.",
    where: { label: "The context bar of the selected call", view: "context", selector: "[data-testid=context-bar]" },
  },
  {
    id: "hidden-part",
    term: "System prompt and tool schemas",
    short: "The hidden part: sent before the first message on every call, never shown in the chat.",
    body:
      "Before your first message, the request holds the schema of every tool the model may use (its name, what it " +
      "does, its parameters) and the system prompt (the harness's own instructions). You never see them in the " +
      "chat, but the model reads them on every call. CLAUDE.md files, project memory, git status and the " +
      "environment are not part of it: the harness adds them to the messages as injected context, after the " +
      "hidden part.",
    where: {
      label: "The hidden part bracket over the context bar",
      view: "context",
      selector: "[data-testid=hidden-part]",
    },
  },
  {
    id: "deferred-tools",
    term: "Deferred tools and ToolSearch",
    short: "Tool schemas that are sent only after the model asks for them.",
    body:
      "A harness with many tools (MCP servers, for example) does not send all their schemas. It sends only their " +
      "names, in a list of injected context sent on every call, and gives the model a ToolSearch tool. When the model needs one, ToolSearch loads its schema, and " +
      "from that call on the schema is sent in the messages. This keeps the hidden part small.",
    where: { label: "Blocks marked Deferred in the block list", view: "context", selector: ".tag.deferred" },
  },
  {
    id: "skill-listing",
    term: "Skill listing",
    short: "The list of skills the model may load: sent as injected context on every call.",
    body:
      "The harness tells the model which skills it can load: the name and a short description of each. Only the " +
      "list is sent; the text of a skill comes in when the model loads it. The list sits in the first message, so " +
      "every later call sends it again, mostly read from the cache. Each installed skill adds to it, used or not. " +
      "The deferred tools list works the same way for tool names.",
    where: {
      label: "The Skill listing row under its block in the block list",
      view: "context",
      selector: '[data-part="Skill listing"]',
    },
  },
  {
    id: "prompt-cache",
    term: "Prompt cache",
    short: "The provider keeps the processed start of a request, so the next call can read it cheaply.",
    body:
      "Each call sends the whole context again, but most of it is the same as last time. The provider keeps what " +
      "it processed, and a later request that starts with the same tokens reads them from the cache: a cache read " +
      "costs 0.05× to 0.1× of the input price, by model. Tokens put into the cache cost more than plain input: " +
      "1.25× for a 5-minute entry, 2× for a 1-hour one. The rest is uncached input, at the full price.",
    where: { label: "How the input was billed, on the timeline", view: "context", selector: ".billing-legend" },
  },
  {
    id: "cached-prefix",
    term: "Cached prefix and breakpoints",
    short: "The cache matches a request from its start up to the first token that differs.",
    body:
      "The request is read in order: tools, then the system prompt, then the messages. The harness marks up to 4 " +
      "places in it as cache breakpoints, and the provider caches the request up to each. A later call reads the " +
      "longest marked prefix it shares. One changed token early in the request makes everything after it new.",
    where: { label: "The cached up to here mark on the context bar", view: "context", selector: ".ctx-boundary" },
  },
  {
    id: "cache-ttl",
    term: "Cache lifetime (TTL)",
    short: "A cache entry lives 5 minutes, or 1 hour when the harness asks for it; each read starts the clock again.",
    body:
      "While calls keep coming, the cache stays warm. After a pause longer than its lifetime, the entry is gone, " +
      "and the next call processes and writes the whole prefix again. The larger the context, the more a pause " +
      "costs.",
    where: { label: "Cache breaks with the reason Cache expired", view: "context", selector: "#what-changed" },
  },
  {
    id: "cache-break",
    term: "Cache break",
    short: "A call that read fewer tokens from the cache than the call before it.",
    body:
      "Quantext names the first reason that fits: a compaction, a model switch, an expired cache, or a change early " +
      "in the request. What changed at that call shows the blocks that differ and where the cached prefix ended.",
    where: { label: "The triangles on the timeline, and What changed", view: "context", selector: "#what-changed" },
  },
  {
    id: "compaction",
    term: "Compaction",
    short: "The harness replaces the conversation with a short summary, to free room in the context.",
    body:
      "One call sends the whole context with the request to summarise it. The calls after start from the tool " +
      "schemas, the system prompt, the context the harness injects again (CLAUDE.md, memory) and the summary. The harness does not log the summarising call, so its numbers " +
      "are derived (Δ) from running totals. The cache of the messages breaks once.",
    where: { label: "The Compactions tab", view: "compactions" },
  },
  {
    id: "subagents",
    term: "Subagents",
    short: "A task the model hands to another model run, in a context of its own.",
    body:
      "The Agent tool starts a new session: its own system prompt and tools, and only the task it was given. Its " +
      "reading and tool outputs stay in its own context; only its final answer comes back, as the Agent tool " +
      "call's output. Its calls cost money, but they do not fill the parent's context.",
    where: { label: "The subagent links in the session head", selector: "[data-testid=subagents]" },
  },
  {
    id: "unlogged-calls",
    term: "Calls the transcript does not show",
    short: "Some model calls of the harness are billed but written to no transcript, so no tool can count them.",
    body:
      "Claude Code writes the progress summary of a running subagent every 30 seconds by sending the subagent's " +
      "whole context to the model again (a cache read plus a short answer). It also makes calls for recaps. None of " +
      "these is in a transcript. In a session with many long subagents they can add 10–15% to the bill. Setting " +
      "CLAUDE_CODE_DISABLE_AGENT_PROGRESS_SUMMARIES=1 turns the summaries off; you then see no live subagent progress.",
    where: { label: "The subagent links in the session head", selector: "[data-testid=subagents]" },
  },
  {
    id: "lifetime-cost",
    term: "Lifetime cost",
    short: "What a block costs over all the calls it stays in.",
    body:
      "A tool output that stays in the context is sent again on every later call, until a compaction removes it. " +
      "Its lifetime cost is its tokens in each of those calls, at the price of the part they fell in (mostly cache " +
      "read). A large file read early can cost more over the session than it did on the call that read it.",
    where: { label: "The Tool calls tab", view: "tools" },
  },
  {
    id: "output-tokens",
    term: "Output and input tokens",
    short: "An answer is paid once as output, then as input on every later call.",
    body:
      "What the model writes on a call (text, reasoning, tool calls) is billed once, at the output price, the " +
      "highest per token. The next call sends that answer back as input, and so does every call after it, " +
      "usually as a cache read, until a compaction replaces it. So a long answer costs a little on each later call too.",
    where: { label: "The Output section of the block list", view: "context", selector: "[data-section=output]" },
  },
  {
    id: "token-basis",
    term: "Token basis marks",
    short: "How a token number was found: exact, ≈ anchored, ~ estimate, or Δ derived.",
    body:
      "A number with no mark is exact: the provider reported it. ≈ anchored is an exact change between two calls " +
      "less the reply before it, off by tens of tokens. ~ estimate splits an exact total between blocks by a token " +
      "estimator: the sum is exact, the share is not. Δ derived is computed from exact running totals, for a call " +
      "whose own usage is not logged. Hover or focus a number for its basis.",
    where: { label: "The block list of the selected call", view: "context", selector: ".basis-mark" },
  },
  {
    id: "lane",
    term: "Lane",
    short: "The calls of a session that build on each other's context: one model, one purpose.",
    body:
      "Besides the main loop, a harness makes side calls (a title, a summary, a check) on another model. Each runs " +
      "in its own lane with its own cache, so the timeline shows one lane at a time.",
    where: { label: "The lane buttons over the timeline", view: "context", selector: ".lanes" },
  },
  {
    id: "memory",
    term: "Project memory",
    short: "Notes the harness keeps for a project across sessions.",
    body:
      "The index, MEMORY.md, is added to each new session in the project as injected context (a message, not the " +
      "system prompt). Claude Code loads its first 200 lines or 25 KB, whichever comes first; those cost tokens " +
      "in every call, and the rest is not loaded. The model opens the other memory files only when it needs one.",
    where: { label: "Project memory, in the session head", selector: ".memory-link" },
  },
];

export const TERM = Object.fromEntries(TERMS.map((t) => [t.id, t])) as Record<string, Term>;

/** Issue kinds in words: what is wrong with a call's data, and what still holds. */
export const ISSUE_WORDS: Record<CallIssue["kind"], string> = {
  "no-request": "No request in the log: exact usage and cost, but no blocks",
  "missing-message": "A message is missing from the log: a gap block takes its tokens",
  "derived-usage-invalid": "The running totals give a summarising call no usable input",
  "unresolved-request": "Part of the request is not in the log: the rebuilt input is incomplete",
  "no-usage": "No usage in the log: the call has no exact total",
  "unreconciled-tokens": "The exact change does not fit the new blocks: the whole total is split by estimate",
  "no-price": "No list price for the model: the call has no cost",
  "price-assumption": "The cost rests on an assumption the log cannot confirm (cache lifetime, long-context price)",
  "estimate-clamped": "A block's estimated share was raised to its lower bound",
  "unlocated-attachment": "A text the harness attached is in no message of the request",
};
