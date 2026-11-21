import type { Engine } from "claude-code/testing";
import { expect, test } from "claude-code/testing";
import { measurer, stepper, toasts, usage } from "./kit.ts";

const MINUTE = 60_000;

const SUMMARY = [{ role: "user" as const, text: "summary", toolUses: [] }];
/** The kit hands the call's argument to the hooks as the event: give it the event's own fields. */
const compact = ($: Engine, trigger = "manual") => $.session.compact({ trigger, messages: SUMMARY } as never);

test("a cache lost after more than an hour idle is an expiry, with its cost", async ($, on) => {
  const seen = toasts(on);
  const { step, clock } = stepper(on);
  await step($, usage(300_000, 1_000));
  await clock.advance(70 * MINUTE);
  await step($, usage(0, 301_000));
  expect(seen).toEqual(["quantext: cache expired after 70 min idle; this call re-wrote 301k tokens (~$1.50)."]);
});

test("a cache lost after 5 to 60 minutes idle names both causes while the cache's lifetime is not known", async ($, on) => {
  const seen = toasts(on);
  const { step, clock } = stepper(on);
  await step($, usage(300_000, 1_000));
  await clock.advance(12 * MINUTE);
  await step($, usage(0, 301_000));
  expect(seen).toEqual([
    "quantext: cache lost after 12 min idle: it expired if it lives 5 min, else the start of the request changed; " +
      "this call re-wrote 301k tokens (~$1.50).",
  ]);
});

test("once the cache held over a pause, a loss within the hour is a prefix change, priced as a 1-hour write", async ($, on) => {
  const seen = toasts(on);
  const { step, clock } = stepper(on);
  await step($, usage(300_000, 1_000));
  await clock.advance(20 * MINUTE);
  await step($, usage(301_000, 1_000)); // read after 20 min: this session's cache lives an hour
  await clock.advance(40 * MINUTE);
  await step($, usage(0, 302_000));
  expect(seen).toEqual([
    "quantext: cache lost after 40 min idle, within its 1-hour lifetime: the start of the request changed " +
      "(tools, MCP servers, CLAUDE.md?); this call re-wrote 302k tokens (~$2.42). /quantext view shows the first change.",
  ]);
});

test("a cache lost with no pause is a prefix change", async ($, on) => {
  const seen = toasts(on);
  const { step, clock } = stepper(on);
  await step($, usage(300_000, 1_000));
  await clock.advance(1 * MINUTE);
  await step($, usage(0, 301_000));
  expect(seen).toEqual([
    "quantext: cache lost after 1 min, with no compaction or model switch: the start of the request changed " +
      "(tools, MCP servers, CLAUDE.md?); this call re-wrote 301k tokens (~$1.50). /quantext view shows the first change.",
  ]);
});

test("a re-write after a compaction is named as such, even after a long pause", async ($, on) => {
  const seen = toasts(on);
  const { step, clock } = stepper(on);
  on("session.compact", () => ({ messages: SUMMARY }));
  await step($, usage(300_000, 1_000));
  await clock.advance(40 * MINUTE);
  await compact($);
  await step($, usage(0, 100_000));
  await clock.advance(1 * MINUTE);
  await step($, usage(0, 101_000)); // the compaction counts for one call only
  expect(seen).toEqual([
    "quantext: cache re-written after a compaction, as expected; this call wrote 100k tokens (~$0.50).",
    "quantext: cache lost after 1 min, with no compaction or model switch: the start of the request changed " +
      "(tools, MCP servers, CLAUDE.md?); this call re-wrote 101k tokens (~$0.51). /quantext view shows the first change.",
  ]);
});

test("a precompute compaction does not count as a compaction", async ($, on) => {
  const seen = toasts(on);
  const { step, clock } = stepper(on);
  on("session.compact", () => ({ messages: SUMMARY }));
  await step($, usage(300_000, 1_000));
  await compact($, "precompute");
  await clock.advance(1 * MINUTE);
  await step($, usage(0, 301_000));
  expect(seen[0]).toContain("the start of the request changed");
});

test("a re-write after a model switch is named as such", async ($, on) => {
  const seen = toasts(on);
  const { step, clock } = stepper(on);
  await step($, usage(300_000, 1_000));
  await clock.advance(1 * MINUTE);
  await step($, { ...usage(0, 301_000), model: "claude-sonnet-5-5" });
  expect(seen).toEqual([
    "quantext: cache re-written after a switch from claude-opus-5-5 to claude-sonnet-5-5 (each model has its own " +
      "cache); this call wrote 301k tokens (~$0.75).",
  ]);
});

test("no cache nudge for a small re-write, or when the cache was still read", async ($, on) => {
  const seen = toasts(on);
  const { step, clock } = stepper(on);
  await step($, usage(10_000, 1_000));
  await clock.advance(70 * MINUTE);
  await step($, usage(0, 15_000)); // 15k re-written: below the threshold
  await clock.advance(1 * MINUTE);
  await step($, usage(10_000, 40_000)); // the cache was read: new content, not a loss
  expect(seen).toEqual([]);
});

test("a subagent's calls raise no cache nudge and do not move the main loop's idle clock", async ($, on) => {
  const seen = toasts(on);
  const { step, clock } = stepper(on);
  await step($, usage(300_000, 1_000));
  await clock.advance(66 * MINUTE);
  await step($, usage(0, 300_000), "agent-1");
  await clock.advance(1 * MINUTE);
  await step($, usage(0, 301_000));
  expect(seen).toEqual(["quantext: cache expired after 67 min idle; this call re-wrote 301k tokens (~$1.50)."]);
});

test("a model with no known price gets the nudge without a cost", async ($, on) => {
  const seen = toasts(on);
  const { step, clock } = stepper(on);
  await step($, { ...usage(300_000, 1_000), model: "some-model" });
  await clock.advance(61 * MINUTE);
  await step($, { ...usage(0, 301_000), model: "some-model" });
  expect(seen).toEqual(["quantext: cache expired after 61 min idle; this call re-wrote 301k tokens."]);
});

test("crossing 200k context raises one nudge, re-armed after a compaction", async ($, on) => {
  const seen = toasts(on);
  const measure = measurer(on);
  on("session.compact", () => ({ messages: SUMMARY }));
  await measure($, 199_000);
  await measure($, 210_000);
  await measure($, 230_000);
  expect(seen).toEqual(["quantext: context is 210k tokens. Consider /compact, /clear-tools or a new session."]);
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
