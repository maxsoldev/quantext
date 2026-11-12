import { expect, test } from "./engine.ts";

test("what changed at a call: the added blocks, and the cache held", async ({ page, engine }) => {
  await page.goto(`${await engine.sessionUrl("basic-tools")}?call=4`);
  const diff = page.getByTestId("diff");
  await expect(diff).toContainText("What changed at call 4");
  await expect(diff).toContainText("against call 3");
  await expect(diff).toContainText("2 blocks");
  await expect(diff).toContainText("read from the cache");
  await expect(page.getByTestId("strip-now").locator('[data-status="added"]')).toHaveCount(2);
  await expect(page.getByTestId("break-note")).toHaveCount(0);
  await page.getByTestId("change-list").getByRole("button").first().click();
  await expect(page.getByTestId("block-panel")).toBeVisible();
});

test("a cache break on the timeline opens what changed, with the reason and what to do", async ({ page, engine }) => {
  await page.goto(`${await engine.sessionUrl("compaction")}?call=3`);
  await page.locator(".break-mark").click();
  await expect(page).toHaveURL(/call=5/);
  const note = page.getByTestId("break-note");
  await expect(note).toContainText("Cache break: Compaction");
  await expect(note).toContainText("What to do");
  await expect(page.getByTestId("strip-before").locator('[data-status="removed"]').first()).toBeVisible();
  await expect(page.getByTestId("diff")).toContainText("first change");
});

test("the first call of a lane has nothing to compare with", async ({ page, engine }) => {
  await page.goto(`${await engine.sessionUrl("basic-tools")}?call=1`);
  await expect(page.getByTestId("diff")).toContainText("The first call of its lane");
});
