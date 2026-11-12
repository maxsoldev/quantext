import type { Engine } from "claude-code/testing";
import { expect, test } from "claude-code/testing";
import { measurer, stepper, toasts, usage } from "./kit.ts";

const MINUTE = 60_000;

test("a cache expiry after an idle gap raises one nudge with its cost", async ($, on) => {
  const seen = toasts(on);
  const { step, clock } = stepper(on);
  await step($, usage(300_000, 1_000));
  await clock.advance(12 * MINUTE);
  await step($, usage(0, 301_000));
  expect(seen).toEqual(["quantext: cache expired after 12 min idle; this call re-wrote 301k tokens (~$1.50)."]);
});

test("no expiry nudge within 5 minutes, for a small re-write, or when the cache was still read", async ($, on) => {
  const seen = toasts(on);
  const { step, clock } = stepper(on);
  await step($, usage(300_000, 1_000));
  await clock.advance(4 * MINUTE);
  await step($, usage(0, 301_000)); // within the time to live: not an expiry
  await clock.advance(6 * MINUTE);
  await step($, usage(0, 15_000)); // 15k re-written: below the threshold
  await step($, usage(0, 300_000));
  await clock.advance(6 * MINUTE);
  await step($, usage(290_000, 40_000)); // the cache was read: new content, not an expiry
  expect(seen).toEqual([]);
});

test("a subagent's calls raise no expiry nudge and do not move the main loop's idle clock", async ($, on) => {
  const seen = toasts(on);
  const { step, clock } = stepper(on);
  await step($, usage(300_000, 1_000));
  await clock.advance(6 * MINUTE);
  await step($, usage(0, 300_000), "agent-1");
  await clock.advance(1 * MINUTE);
  await step($, usage(0, 301_000));
  expect(seen).toEqual(["quantext: cache expired after 7 min idle; this call re-wrote 301k tokens (~$1.50)."]);
});

test("a model with no known price gets the nudge without a cost", async ($, on) => {
  const seen = toasts(on);
  const { step, clock } = stepper(on);
  await step($, { ...usage(300_000, 1_000), model: "some-model" });
  await clock.advance(6 * MINUTE);
  await step($, { ...usage(0, 301_000), model: "some-model" });
  expect(seen).toEqual(["quantext: cache expired after 6 min idle; this call re-wrote 301k tokens."]);
});

const SUMMARY = [{ role: "user" as const, text: "summary", toolUses: [] }];
/** The kit hands the call's argument to the hooks as the event: give it the event's own fields. */
const compact = ($: Engine) => $.session.compact({ trigger: "manual", messages: SUMMARY } as never);

test("crossing 200k context raises one nudge, re-armed after a compaction", async ($, on) => {
  const seen = toasts(on);
  const measure = measurer(on);
  on("session.compact", () => ({ messages: SUMMARY }));
  await measure($, 199_000);
  await measure($, 210_000);
  await measure($, 230_000);
  expect(seen).toEqual(["quantext: context is 210k tokens. Consider /compact, /clear-tool-outputs or a new session."]);
  await compact($);
  await measure($, 205_000);
  expect(seen.length).toBe(2);
});

test("the context nudge is re-armed after /clear", async ($, on) => {
  const seen = toasts(on);
  const measure = measurer(on);
  on("session.end", (_$, e) => ({ sessionId: e.sessionId }));
  await measure($, 250_000);
  await $.session.end({ reason: "clear", sessionId: "s1", resume: {} } as never);
  await measure($, 250_000);
  expect(seen.length).toBe(2);
});
