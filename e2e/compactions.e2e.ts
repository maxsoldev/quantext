import { expect, test } from "./engine.ts";

test("a compaction shows what was removed and kept, the summary, and the derived summary call", async ({
  page,
  engine,
}) => {
  await page.goto(await engine.sessionUrl("compaction"));
  await page.getByRole("link", { name: /Compactions/ }).click();
  const card = page.getByTestId("compaction");
  await expect(card).toHaveCount(1);
  await expect(card).toContainText("removed 3,807 tokens");
  await expect(card).toContainText("A summary of 738 tokens");
  await expect(page.getByTestId("before-bar").locator('[data-part="removed"]').first()).toBeVisible();
  await expect(page.getByTestId("after-bar").locator('[data-part="summary"]')).toHaveCount(1);
  await expect(card).toContainText("derived");
  await expect(card.locator(".basis-derived").first()).toBeVisible();
  await card.getByRole("link", { name: /Context after/ }).click();
  await expect(page).toHaveURL(/call=4/);
  await expect(page.getByTestId("break-note")).toContainText("Compaction");
});

test("a session with no compaction says what one is", async ({ page, engine }) => {
  await page.goto(`${await engine.sessionUrl("basic-tools")}/compactions`);
  await expect(page.getByTestId("compactions")).toContainText("No compaction in this session");
});
