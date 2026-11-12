import type { Page } from "@playwright/test";
import { expect, test } from "./engine.ts";

async function open(page: Page, url: string) {
  await page.goto(url);
  await expect(page.getByTestId("block-row").first()).toBeVisible();
}

const num = (s: string) => Number(s.replace(/[^\d.]/g, ""));

test("the token-share table lists the categories and their parts by share, largest first", async ({ page, engine }) => {
  await open(page, `${await engine.sessionUrl("basic-tools")}?call=7`);
  const table = page.getByRole("table", { name: "Tokens by category" });
  const shares = (await table.locator("tbody tr:not(.cat-sub) .share .num").allTextContents()).map(num);
  expect(shares.length).toBeGreaterThan(3);
  expect(shares).toEqual([...shares].sort((a, b) => b - a));
  await table.getByTestId("category-toggle").first().click();
  const parts = (await table.getByTestId("part-total").locator("td.muted").allTextContents()).map(num);
  expect(parts.length).toBeGreaterThan(1);
  expect(parts).toEqual([...parts].sort((a, b) => b - a));
});
