/** The Quantext mod: a footer label and nudges from in-process usage, /clear-tool-outputs, /quantext view. */
import type { EngineInterface, Register } from "claude-code";
import { clearToolOutputs, parseKeep, toolOutputsKeep } from "./clear-tool-outputs.ts";
import { tokens } from "./format.ts";
import { EMPTY, inputOf, readLive, statusLabel, updateLive } from "./live.ts";
import { cacheExpiryNudge, contextNudge } from "./nudges.ts";

/**
 * Queues `/compact tool-outputs keep N`, which the session.compact hook answers. `$.session.compact()` would
 * skip that hook and get Claude Code's summary; `$.command.run` queues the command as if typed.
 */
async function clearNow($: EngineInterface, keep: number): Promise<void> {
  try {
    await $.command.run({ command: "compact", args: `tool-outputs keep ${keep}` });
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    $.ui.toast(`clear-tool-outputs failed: ${why}; try /compact tool-outputs`);
  }
}

export const register: Register = (on) => {
  on("session.start", async ($, e, next) => {
    const started = await next(e);
    await $.command.register({
      name: "clear-tool-outputs",
      description: "Clear old tool outputs from the context and keep all else (also: /compact tool-outputs)",
      argumentHint: "[keep N]",
    });
    return started;
  });

  on("command.run", { command: "clear-tool-outputs" }, async ($, e) => {
    const keep = parseKeep(e.args);
    if (keep === undefined) return { text: "Usage: /clear-tool-outputs [keep N]" };
    $.clock.after(0, () => void clearNow($, keep)); // Claude Code refuses a compaction inside command.run
    return { text: keep > 0 ? `Clearing tool outputs, keeping the last ${keep}…` : "Clearing tool outputs…" };
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
    }));
    if (nudge !== undefined) $.ui.toast(nudge);
    return r;
  });

  // Answers /clear-tool-outputs and `/compact tool-outputs [keep N]` in Claude Code's place: no summary.
  on("session.compact", async ($, e, next) => {
    const keep = e.agentId === undefined ? toolOutputsKeep(e.instructions) : undefined;
    let r: Awaited<ReturnType<typeof next>>;
    if (keep === undefined) r = await next(e);
    else {
      const cleared = clearToolOutputs(e.messages, keep);
      const kept = keep > 0 ? `, kept the last ${keep}` : "";
      $.ui.toast(`Cleared ${cleared.cleared} tool outputs (~${tokens(cleared.chars / 4)} tokens)${kept}`);
      r = { messages: cleared.messages };
    }
    if (e.agentId === undefined && e.trigger !== "precompute" && r.messages !== undefined) {
      await updateLive($, (l) => ({ ...l, bigCtxNudged: false }));
    }
    return r;
  });

  // A /clear ends this conversation and goes on with a new one: start its figures over.
  on("session.end", async ($, e, next) => {
    const r = await next(e);
    if (e.reason === "clear") await updateLive($, () => EMPTY);
    return r;
  });

  // Appends to the footer's mode labels, so the labels of other plugins stay.
  on("ui.render", { component: "SessionMode" }, async ($, e, next) => {
    const label = statusLabel(await readLive($));
    if (label === undefined) return next(e);
    return next({ ...e, props: { ...e.props, modes: [...e.props.modes, label] } });
  });
};
