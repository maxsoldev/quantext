import type { On } from "claude-code";
import type { Engine } from "claude-code/testing";
import { expect, test } from "claude-code/testing";
import { command, draw, footer, stepper, toasts, usage } from "./kit.ts";

const MINUTE = 60_000;
const LOST = /^cache lost after 1 min, with no compaction or model switch/;

const pane = (placement: "dock" | "inline" = "dock") =>
  ({
    plugin: "quantext",
    component: "Pane",
    requestId: "quantext",
    surface: "terminal",
    props: {
      title: "Quantext",
      isFocused: false,
      bodyColumns: 40,
      placement,
      scroll: { offset: 0, bodyRows: 20 },
      view: {},
    },
  }) as const;

/** The engine's record of this plugin's panes, as `$.ui.open`, `close` and `panes` keep it. */
function panes(on: On): Set<string> {
  const open = new Set<string>();
  on("ui.open", (_$, e) => {
    open.add(e.id);
    return { value: { isPlaced: true } };
  });
  on("ui.close", (_$, e) => {
    open.delete(e.id);
    return { value: undefined };
  });
  on("ui.panes", () => ({
    value: [...open].map((id) => ({ id, title: "Quantext", isShown: true, isFocused: false, isPlaced: true })),
  }));
  return open;
}

/** `lose($, n)`: n more cache losses, one minute apart, each one a nudge. Made before the test's first `$` call. */
function losses(on: On) {
  const { step, clock } = stepper(on);
  let i = 0;
  return async ($: Engine, n: number) => {
    if (i === 0) await step($, usage(300_000, 1_000));
    for (let k = 0; k < n; k++, i++) {
      await clock.advance(MINUTE);
      await step($, usage(0, 301_000 + i));
    }
  };
}

/** The words of each row of the pane, top to bottom, with no time. */
async function rows($: Engine, placement: "dock" | "inline" = "dock"): Promise<string[]> {
  const ui = await $.ui.mount(pane(placement));
  const found = await ui.findAll({ type: "Text" });
  await ui.unmount();
  return found.map((t) => t.text ?? "").filter((t) => !/^\d\d:\d\d$/.test(t));
}

test("a nudge is still a toast, and it stays in the pane after the toast is gone", async ($, on) => {
  const lose = losses(on);
  const seen = toasts(on);
  await lose($, 1);
  expect(seen).toHaveLength(1);
  const [row] = await rows($);
  expect(row).toMatch(LOST); // without the "quantext: " the pane's title already says
});

test("the pane shows the newest message first, each with its time", async ($, on) => {
  const lose = losses(on);
  toasts(on);
  await lose($, 2);
  const ui = await $.ui.mount(pane());
  const texts = (await ui.findAll({ type: "Text" })).map((t) => t.text ?? "");
  await ui.unmount();
  expect(texts.filter((t) => /^\d\d:\d\d$/.test(t))).toHaveLength(2);
  const words = texts.filter((t) => !/^\d\d:\d\d$/.test(t));
  expect(words[0]).toContain("301k tokens"); // 301,001: the second loss
  expect(words[0]).not.toBe(words[1]);
});

test("the pane keeps the newest 50 messages", async ($, on) => {
  const lose = losses(on);
  toasts(on);
  await lose($, 53);
  expect(await rows($)).toHaveLength(50);
});

test("inline above the prompt, where the frame grows with its rows, the pane shows the newest 5", async ($, on) => {
  const lose = losses(on);
  toasts(on);
  await lose($, 8);
  expect(await rows($, "inline")).toHaveLength(5);
});

test("with no message yet, the pane says so", async ($) => {
  expect(await rows($)).toEqual(["No messages yet. Quantext's toasts land here."]);
});

test("/quantext opens the pane, and a second /quantext closes it", async ($, on) => {
  const open = panes(on);
  const first = await $.command.run(command("quantext"));
  expect([...open]).toEqual(["quantext"]);
  expect(first.text).toMatch(/pane/);
  await $.command.run(command("quantext"));
  expect([...open]).toEqual([]);
});

test("the footer counts the messages shown while the pane was closed, until /quantext opens it", async ($, on) => {
  const lose = losses(on);
  const modes = footer(on);
  panes(on);
  toasts(on);
  await lose($, 2);
  await draw($);
  expect(modes().at(-1)).toBe("qx 2 new"); // no context measured yet: the count alone
  await $.command.run(command("quantext"));
  await draw($);
  expect(modes().at(-1)).not.toMatch(/new/);
  await lose($, 1); // the pane is open: the person sees it there
  await draw($);
  expect(modes().at(-1)).not.toMatch(/new/);
});

test("the messages stay after a /clear", async ($, on) => {
  const lose = losses(on);
  toasts(on);
  on("session.end", (_$, e) => ({ sessionId: e.sessionId }));
  await lose($, 1);
  await $.session.end({ reason: "clear", sessionId: "s1", resume: {} } as never);
  expect(await rows($)).toHaveLength(1);
});

test("/quantext with anything but view says how to use it", async ($) => {
  const r = await $.command.run(command("quantext", "nope"));
  expect(r.text).toBe("Usage: /quantext (the messages pane) or /quantext view (the viewer)");
});
