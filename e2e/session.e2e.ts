import { expect, test } from "./engine.ts";

test("the timeline shows each Call and follows the latest one", async ({ page, engine }) => {
  await page.goto(await engine.sessionUrl("basic-tools"));
  const chart = page.getByTestId("timeline");
  await expect(chart).toBeVisible();
  await expect(page.getByTestId("call-position")).toContainText("Call 7");
  await expect(page.getByTestId("call-position")).toContainText("8 of 8");
});

test("arrow keys and the scrubber move the selected Call, kept in the URL", async ({ page, engine }) => {
  await page.goto(await engine.sessionUrl("basic-tools"));
  await expect(page.getByTestId("call-position")).toContainText("Call 7");
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByTestId("call-position")).toContainText("Call 6");
  await expect(page).toHaveURL(/call=6/);
  await page.keyboard.press("Home");
  await expect(page.getByTestId("call-position")).toContainText("Call 0");
  await page.getByTestId("scrubber").fill("3");
  await expect(page.getByTestId("call-position")).toContainText("Call 3");
});

test("hovering a Call shows its tokens by category and billing part", async ({ page, engine }) => {
  await page.goto(await engine.sessionUrl("basic-tools"));
  const box = await page.getByTestId("timeline").boundingBox();
  if (!box) throw new Error("no chart");
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
  const tip = page.getByTestId("chart-tip");
  await expect(tip).toContainText("Tool definitions");
  await expect(tip).toContainText("Cache read");
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await expect(page).toHaveURL(/call=\d+/);
});

test("a compaction is marked on the timeline", async ({ page, engine }) => {
  await page.goto(await engine.sessionUrl("compaction"));
  await expect(page.locator(".compaction-mark")).toHaveCount(1);
});
