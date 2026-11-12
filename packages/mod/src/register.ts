/** The Quantext mod: a footer label and nudges from in-process usage, /clear-tools, /quantext view. */
import type { EngineInterface, Register } from "claude-code";
import type { ClearArgs } from "./clear-tools.ts";
import { clearRequest, clearTools, clearWhat, compactArgs, parseClearArgs, USAGE } from "./clear-tools.ts";
import { EMPTY, inputOf, readLive, statusLabel, updateLive } from "./live.ts";
import { cacheExpiryNudge, contextNudge } from "./nudges.ts";
import { openViewer } from "./viewer.ts";

/**
 * Queues `/compact tools [outputs] keep N`, which the session.compact hook answers. `$.session.compact()` would
 * skip that hook and get Claude Code's summary; `$.command.run` queues the command as if typed.
 */
async function clearNow($: EngineInterface, a: ClearArgs): Promise<void> {
  const args = compactArgs(a);
  try {
    await $.command.run({ command: "compact", args });
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    $.ui.toast(`/clear-tools failed: ${why}; try /compact ${args}`);
  }
}

/** How long after a start or a compaction to count the context: the transcript has settled by then. */
const REMEASURE_DELAY_MS = 500;

/**
 * Counts the context again (at start, and once a compaction has landed). The measured figure is the last
 * response's input, so it stays at the old size until the next call; Claude Code's local estimate (as /context
 * makes it) sees the new transcript at once.
 */
async function remeasure($: EngineInterface): Promise<void> {
  const { context, cost } = await $.session.usage({ breakdown: "summary" });
  const ctx = context.breakdown?.totalTokens;
  if (ctx === undefined || ctx === 0) return;
  await updateLive($, (l) => ({ ...l, ctx, lastCtx: ctx, ...(cost === undefined ? {} : { usd: cost.usd }) }));
}

/** Runs `remeasure` soon, from a timer: its failure goes to the debug log, never into the hook that asked. */
function remeasureSoon($: EngineInterface): void {
  $.clock.after(
    REMEASURE_DELAY_MS,
    () =>
      void remeasure($).catch((error: unknown) =>
        $.ui.log(`quantext: re-count failed: ${String(error)}`, { to: "debug" }),
      ),
  );
}

export const register: Register = (on) => {
  on("session.start", async ($, e, next) => {
    const started = await next(e);
    await $.command.register({
      name: "clear-tools",
      description:
        "Clear old tool calls and outputs, no summary. outputs: only outputs; keep N: leave the last N (also: /compact tools)",
      argumentHint: "[outputs] [keep N]",
    });
    await $.command.register({
      name: "quantext",
      description: "Quantext: open the live context viewer (starts the engine when it is not running)",
      argumentHint: "view",
    });
    if (e.isInteractive) remeasureSoon($); // show the context before the first call
    return started;
  });

  on("command.run", { command: "clear-tools" }, async ($, e) => {
    const a = parseClearArgs(e.args);
    if ("error" in a) return { text: `/clear-tools: ${a.error}. ${USAGE}` };
    $.clock.after(0, () => void clearNow($, a)); // Claude Code refuses a compaction inside command.run
    const what = clearWhat(a);
    return { text: a.keep > 0 ? `Clearing ${what}, keeping the last ${a.keep}…` : `Clearing ${what}…` };
  });

  on("session.measure", async ($, e, next) => {
    const r = await next(e);
    const ctx = e.context.tokens;
    const nudge = ctx === undefined ? undefined : contextNudge(await readLive($), ctx);
    await updateLive($, (l) => ({
      ...l,
      ctx: ctx ?? l.ctx,
      ...(e.cost === undefined ? {} : { usd: e.cost.usd }),
      bigCtxNudged: l.bigCtxNudged || nudge !== undefined,
    }));
    if (nudge !== undefined) $.ui.toast(nudge);
    return r;
  });

  on("turn.step", async function* ($, e, next) {
    const startedAt = await $.clock.now();
    const r = yield* next(e);
    const u = r.usage;
    if (u === null || e.agentId !== undefined) return r; // subagents have their own caches: count the main loop
    const nudge = cacheExpiryNudge(await readLive($), u, startedAt);
    const endedAt = await $.clock.now();
    await updateLive($, (l) => ({
      ...l,
      read: l.read + u.cache_read_input_tokens,
      input: l.input + u.input_tokens + u.cache_creation_input_tokens,
      lastEndAt: endedAt,
      lastCtx: inputOf(u),
      model: u.model,
    }));
    if (nudge !== undefined) $.ui.toast(nudge);
    return r;
  });

  on("command.run", { command: "quantext" }, async ($, e) => {
    if (e.args.trim().toLowerCase() !== "view") return { text: "Usage: /quantext view" };
    // The flow waits up to ~11 s, past a hook's budget: it runs from a timer and answers with toasts.
    $.clock.after(
      0,
      () =>
        void openViewer($).catch((error: unknown) => $.ui.toast(`quantext: /quantext view failed: ${String(error)}`)),
    );
    return { text: "quantext: opening the viewer…" };
  });

  // Answers `/compact tools [outputs] [keep N]` (queued by /clear-tools) in Claude Code's place: no summary.
  on("session.compact", async ($, e, next) => {
    const asked = e.agentId === undefined ? clearRequest(e.instructions) : undefined;
    let r: Awaited<ReturnType<typeof next>>;
    let note: string | undefined;
    if (asked === undefined) r = await next(e);
    else {
      const cleared = clearTools(e.messages, asked, await readLive($));
      if ("skip" in cleared) return cleared; // no change: no compact boundary, no cache re-write
      note = cleared.note;
      r = { messages: cleared.messages };
    }
    if (e.agentId === undefined && e.trigger !== "precompute" && r.messages !== undefined) {
      await updateLive($, (l) => ({ ...l, bigCtxNudged: false }));
      remeasureSoon($);
    }
    if (note !== undefined) $.ui.toast(note); // after the update, so a failed clear shows no "Cleared"
    return r;
  }).catch((_$, e, next) => {
    // A failed clear must not fall back to a paid summary; any other failure leaves it to Claude Code.
    const asked = e.agentId === undefined ? clearRequest(e.instructions) : undefined;
    return asked && !next.called ? { skip: `quantext: clearing ${clearWhat(asked)} failed` } : next(e);
  });

  // A /clear ends this conversation and goes on with a new one: start its figures over.
  on("session.end", async ($, e, next) => {
    const r = await next(e);
    if (e.reason === "clear") {
      await updateLive($, () => EMPTY);
      remeasureSoon($);
    }
    return r;
  });

  // Appends to the footer's mode labels, so the labels of other plugins stay.
  on("ui.render", { component: "SessionMode" }, async ($, e, next) => {
    const label = statusLabel(await readLive($));
    if (label === undefined) return next(e);
    return next({ ...e, props: { ...e.props, modes: [...e.props.modes, label] } });
  });
};
