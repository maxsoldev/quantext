/** What the tests stand in for beneath the mod: the footer, the model's calls, toasts, the clock. */
import type { On, TurnUsage } from "claude-code";
import type { Engine } from "claude-code/testing";
import { mock } from "claude-code/testing";

export const MODEL = "claude-opus-5-5";

export const usage = (read: number, write: number, input = 0): TurnUsage => ({
  model: MODEL,
  input_tokens: input,
  output_tokens: 10,
  cache_read_input_tokens: read,
  cache_creation_input_tokens: write,
});

/** The footer as Claude Code draws it: records the mode labels the plugins above handed down. */
export function footer(on: On): () => readonly string[] {
  let modes: readonly string[] = [];
  on("ui.render", { component: "SessionMode" }, ($, e) => {
    modes = e.props.modes;
    const { Text } = $.ui.resolve(e);
    return h(Text, {}, modes.join(" · ")) as never; // h() is typed as a node; the bottom answers an element
  });
  return () => modes;
}

export const draw = ($: Engine, modes: string[] = []) =>
  $.ui.render({ component: "SessionMode", surface: "terminal", props: { modes } } as never);

/** Records each toast: what the person sees, and never the model. */
export function toasts(on: On): string[] {
  const seen: string[] = [];
  on("ui.toast", (_$, e) => {
    seen.push(e.text);
    return { value: undefined };
  });
  return seen;
}

/** The session's measurement as the engine pushes it. */
export function measurer(on: On) {
  on("session.measure", (_$, e) => ({ changed: e.changed }));
  return ($: Engine, tokens: number, usd?: number) =>
    $.session.measure({
      context: { tokens, window: 1_000_000 },
      rateLimits: [],
      ...(usd === undefined ? {} : { cost: { usd } }),
      changed: ["context"],
    });
}

/** Model calls, one per `step($, usage)`, on the main loop or a subagent's; a clock the test moves. */
export function stepper(on: On, now = 1_000_000) {
  const clock = mock.clock(on, { now });
  const answers: (TurnUsage | null)[] = [];
  // biome-ignore lint/correctness/useYield: the engine's stream here answers with no chunks, only the result
  on("turn.step", async function* (_$, e) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: "",
      toolUses: [],
      stopReason: "end_turn",
      usage: answers[e.index] ?? null,
    };
  });
  let index = 0;
  const step = async ($: Engine, u: TurnUsage | null, agentId?: string) => {
    answers[index] = u;
    const e = { turnId: "t1", index: index++, model: MODEL, messageCount: 3, ...(agentId ? { agentId } : {}) };
    for await (const _ of $.turn.step(e)) {
      // drain the stream
    }
  };
  return { step, clock };
}
