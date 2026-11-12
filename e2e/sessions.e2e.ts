import { expect, test } from "./engine.ts";

test("the session list shows every fixture Session with its numbers", async ({ page, engine }) => {
  await page.goto(engine.url);
  const rows = page.getByTestId("session-row");
  await expect(rows).toHaveCount(7);
  await expect(rows.first()).toContainText("opus-5-5");
  await expect(rows.first()).toContainText("Full");
  await expect(rows.first()).toContainText("$");
});

test("sort and search are in the URL and filter the list", async ({ page, engine }) => {
  await page.goto(engine.url);
  await page.getByTestId("sort").selectOption("calls");
  await expect(page).toHaveURL(/sort=calls/);
  await expect(page.getByTestId("calls").first()).toHaveText("8");
  await page.getByTestId("search").fill("000000000004");
  await expect(page).toHaveURL(/q=000000000004/);
  await expect(page.getByTestId("session-row")).toHaveCount(1);
  await page.reload();
  await expect(page.getByTestId("session-row")).toHaveCount(1);
  await expect(page.getByTestId("search")).toHaveValue("000000000004");
});

test("a number explains its basis on keyboard focus", async ({ page, engine }) => {
  await page.goto(engine.url);
  await page.getByTestId("session-row").first().getByRole("button", { name: "Full" }).focus();
  await expect(page.getByTestId("tooltip")).toContainText("every request");
});

test("arrow keys move between rows and Enter opens the Session", async ({ page, engine }) => {
  await page.goto(engine.url);
  await page.getByTestId("session-row").first().getByRole("link").focus();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByTestId("session-row").nth(1).getByRole("link")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/s\/\d+\//);
});
