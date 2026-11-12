import { appendRest, expect, fixtureLines, startEngine, test } from "./engine.ts";

test("a Session that grows updates in the list, and two tabs share one event stream", async ({ context }) => {
  const half = Math.floor(fixtureLines("basic-tools") / 2);
  const engine = await startEngine({ scenarios: ["basic-tools"], firstLines: { "basic-tools": half } });
  try {
    const first = await context.newPage();
    const second = await context.newPage();
    await first.goto(engine.url);
    await second.goto(engine.url);
    for (const page of [first, second])
      await expect(page.getByTestId("live-status")).toHaveAttribute("data-connection", "open");
    const status = (await (await first.request.get(`${engine.url}/api/v1/status`)).json()) as { streams: number };
    expect(status.streams).toBe(1);
    const before = Number(await first.getByTestId("calls").first().textContent());
    appendRest(engine, "basic-tools", half);
    for (const page of [first, second]) await expect(page.getByTestId("calls").first()).not.toHaveText(String(before));
  } finally {
    await engine.stop();
  }
});

test("when the leader tab closes, the other tab takes over the stream", async ({ context }) => {
  const half = Math.floor(fixtureLines("basic-tools") / 2);
  const engine = await startEngine({ scenarios: ["basic-tools"], firstLines: { "basic-tools": half } });
  try {
    const first = await context.newPage();
    await first.goto(engine.url);
    await expect(first.getByTestId("live-status")).toHaveAttribute("data-connection", "open");
    const second = await context.newPage();
    await second.goto(engine.url);
    await expect(second.getByTestId("live-status")).toHaveAttribute("data-connection", "open");
    const before = Number(await second.getByTestId("calls").first().textContent());
    await first.close();
    await expect(second.getByTestId("live-status")).toHaveAttribute("data-connection", "open");
    appendRest(engine, "basic-tools", half);
    await expect(second.getByTestId("calls").first()).not.toHaveText(String(before));
  } finally {
    await engine.stop();
  }
});
