import { expect, test } from "claude-code/testing";
import { draw, footer, measurer, stepper, usage } from "./kit.ts";

test("the label shows the harness's cost, the context and the cache hit rate, beside other labels", async ($, on) => {
  const modes = footer(on);
  const measure = measurer(on);
  const { step } = stepper(on);
  await step($, usage(0, 10_000, 1_000));
  await step($, usage(30_000, 0, 9_000));
  await measure($, 333_000, 14.456);
  await draw($, ["stash 3"]);
  // 30k of the 50k input tokens were read from the cache
  expect(modes()).toEqual(["stash 3", "qx $14.46 · ctx 333k · cache 60%"]);
});

test("subagent calls do not count toward the cache rate", async ($, on) => {
  const modes = footer(on);
  const measure = measurer(on);
  const { step } = stepper(on);
  await step($, usage(90_000, 10_000));
  await step($, usage(0, 100_000), "agent-1");
  await measure($, 100_000, 1);
  await draw($);
  expect(modes()).toEqual(["qx $1.00 · ctx 100k · cache 90%"]);
});

test("no label before the first measurement; no cache part before the first call; large values are short", async ($, on) => {
  const modes = footer(on);
  const measure = measurer(on);
  await draw($, ["stash 3"]);
  expect(modes()).toEqual(["stash 3"]);
  await measure($, 1_234_567, 123.4);
  await draw($);
  expect(modes()).toEqual(["qx $123 · ctx 1.2M"]);
});

test("without a cost ledger the label leaves the cost out", async ($, on) => {
  const modes = footer(on);
  const measure = measurer(on);
  await measure($, 5_000);
  await draw($);
  expect(modes()).toEqual(["qx ctx 5k"]);
});
