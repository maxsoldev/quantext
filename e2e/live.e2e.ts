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
    const reads: string[] = [];
    first.on("request", (r) => {
      if (r.url().includes("/api/v1/sessions?")) reads.push(r.url());
    });
    appendRest(engine, "basic-tools", half);
    for (const page of [first, second]) await expect(page.getByTestId("calls").first()).not.toHaveText(String(before));
    // The list reads only what changed since its cursor, not all of its pages again.
    expect(reads.some((u) => u.includes("changedSince="))).toBe(true);
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

test("an open Session page follows the new Calls as the harness writes them", async ({ page }) => {
  const half = Math.floor(fixtureLines("basic-tools") / 2);
  const engine = await startEngine({ scenarios: ["basic-tools"], firstLines: { "basic-tools": half } });
  try {
    await page.goto(await engine.sessionUrl("basic-tools"));
    const position = page.getByTestId("call-position");
    await expect(position).toBeVisible();
    const before = await position.textContent();
    appendRest(engine, "basic-tools", half);
    await expect(position).not.toHaveText(before ?? "");
    await expect(position).toContainText("Call 7");
    await expect(page.getByTestId("context")).toContainText("Context at call 7");
  } finally {
    await engine.stop();
  }
});
