/** The Quantext mod: a footer label and nudges from in-process usage, /clear-tool-outputs, /quantext view. */
import type { Register } from "claude-code";
import { inputOf, readLive, statusLabel, updateLive } from "./live.ts";

export const register: Register = (on) => {
  on("session.measure", async ($, e, next) => {
    const r = await next(e);
    await updateLive($, (l) => ({
      ...l,
      ctx: e.context.tokens ?? l.ctx,
      ...(e.cost === undefined ? {} : { usd: e.cost.usd }),
    }));
    return r;
  });

  on("turn.step", async function* ($, e, next) {
    const r = yield* next(e);
    const u = r.usage;
    if (u === null || e.agentId !== undefined) return r; // subagents have their own caches: count the main loop
    const endedAt = await $.clock.now();
    await updateLive($, (l) => ({
      ...l,
      read: l.read + u.cache_read_input_tokens,
      input: l.input + u.input_tokens + u.cache_creation_input_tokens,
      lastEndAt: endedAt,
      lastCtx: inputOf(u),
    }));
    return r;
  });

  // Appends to the footer's mode labels, so the labels of other plugins stay.
  on("ui.render", { component: "SessionMode" }, async ($, e, next) => {
    const label = statusLabel(await readLive($));
    if (label === undefined) return next(e);
    return next({ ...e, props: { ...e.props, modes: [...e.props.modes, label] } });
  });
};
