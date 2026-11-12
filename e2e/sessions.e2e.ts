import { expect, test } from "./engine.ts";

test("the session list shows every fixture Session", async ({ page, engine }) => {
  await page.goto(engine.url);
  await expect(page.getByTestId("session-row")).toHaveCount(7);
});
