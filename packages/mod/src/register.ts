/** The Quantext mod: a footer label and nudges from in-process usage, /clear-tool-outputs, /quantext view. */
import type { Register } from "claude-code";
import { EMPTY, inputOf, readLive, statusLabel, updateLive } from "./live.ts";
import { cacheExpiryNudge, contextNudge } from "./nudges.ts";

export const register: Register = (on) => {
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

  on("session.compact", async ($, e, next) => {
    const r = await next(e);
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
