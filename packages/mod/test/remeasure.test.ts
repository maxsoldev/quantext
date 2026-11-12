import type { On } from "claude-code";
import { expect, mock, test } from "claude-code/testing";
import { draw, footer } from "./kit.ts";

/** Claude Code's own count of the context (as /context estimates it), which the test sets. */
function counter(on: On) {
  const state = { total: 0, asked: 0 };
  on("session.usage", () => {
    state.asked++;
    const breakdown = { totalTokens: state.total } as never;
    return { value: { startedAt: 0, context: { window: 1_000_000, breakdown }, rateLimits: [], cost: { usd: 2 } } };
  });
  return state;
}

test("an interactive session shows its context soon after it starts, before the first call", async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 });
  const modes = footer(on);
  const count = counter(on);
  on("session.start", (_$, e) => ({ cwd: e.cwd }));
  on("command.register", (_$, e) => ({ value: { command: e.name } }));
  count.total = 42_000;
  await $.session.start({ cwd: "/", surface: "terminal", isInteractive: true });
  await clock.advance(1_000);
  await draw($);
  expect(modes()).toEqual(["qx $2.00 · ctx 42k"]);
});

test("a non-interactive session does not count", async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 });
  const count = counter(on);
  on("session.start", (_$, e) => ({ cwd: e.cwd }));
  on("command.register", (_$, e) => ({ value: { command: e.name } }));
  await $.session.start({ cwd: "/", surface: null, isInteractive: false });
  await clock.advance(1_000);
  expect(count.asked).toBe(0);
});

test("the context is counted again once a compaction has landed", async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 });
  const modes = footer(on);
  const count = counter(on);
  on("session.measure", (_$, e) => ({ changed: e.changed }));
  on("session.compact", () => ({ messages: [{ role: "user", text: "summary", toolUses: [] }] }));
  await $.session.measure({ context: { tokens: 300_000, window: 1_000_000 }, rateLimits: [], changed: ["context"] });
  count.total = 25_000;
  await $.session.compact({ trigger: "auto", messages: [{ role: "user", text: "hi", toolUses: [] }] } as never);
  await clock.advance(1_000);
  await draw($);
  expect(modes()).toEqual(["qx $2.00 · ctx 25k"]);
});

test("a compaction made ahead of time (precompute) or a subagent's does not count again", async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 });
  const count = counter(on);
  on("session.compact", () => ({ messages: [{ role: "user", text: "summary", toolUses: [] }] }));
  const messages = [{ role: "user", text: "hi", toolUses: [] }];
  await $.session.compact({ trigger: "precompute", messages } as never);
  await $.session.compact({ trigger: "auto", agentId: "a1", messages } as never);
  await clock.advance(1_000);
  expect(count.asked).toBe(0);
});

test("after /clear the figures start over from a new count", async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 });
  const modes = footer(on);
  const count = counter(on);
  on("session.measure", (_$, e) => ({ changed: e.changed }));
  on("session.end", (_$, e) => ({ sessionId: e.sessionId }));
  await $.session.measure({ context: { tokens: 300_000, window: 1_000_000 }, rateLimits: [], changed: ["context"] });
  count.total = 18_000;
  await $.session.end({ reason: "clear", sessionId: "s1", resume: {} } as never);
  await clock.advance(1_000);
  await draw($);
  expect(modes()).toEqual(["qx $2.00 · ctx 18k"]);
});
