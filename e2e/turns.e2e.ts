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

const earlier = (page: Page) => page.getByTestId("earlier-row");
const turnRow = (page: Page, n: number) => page.locator(`[data-testid="turn-row"][data-turn="${n}"]`);
const positions = async (page: Page) =>
  (
    await page.getByTestId("block-row").evaluateAll((rows) => rows.map((r) => Number(r.getAttribute("data-pos"))))
  ).filter((p) => p >= 13 && p < 25);

test("earlier turns fold into one row that sums them; the call's own turn is open", async ({ page, engine }) => {
  await open(page, `${await engine.sessionUrl("resume")}?call=4`);
  await expect(earlier(page)).toContainText(/Earlier turns\s*2 turns, 8 blocks, [\d.]+% of the input/);
  await expect(earlier(page)).toContainText(/cached/);
  await expect(earlier(page).locator(".group-toggle")).toHaveAttribute("aria-expanded", "false");
  await expect(turnRow(page, 3)).toContainText("This call's turn");
  await expect(turnRow(page, 3)).toContainText("Use the Skill tool");
  await expect(turnRow(page, 1)).toHaveCount(0);
  expect(await positions(page)).toEqual([21, 22, 23, 24]);
});

test("the earlier row opens into a row per turn, and a turn into its blocks; this holds on the next call", async ({
  page,
  engine,
}) => {
  await open(page, `${await engine.sessionUrl("resume")}?call=4`);
  await earlier(page).locator(".group-toggle").click();
  await expect(turnRow(page, 1)).toContainText(/Turn 1\s*Summarise @notes.txt in one line.\s*6 blocks/);
  await expect(turnRow(page, 2)).toContainText("How many list items");
  expect(await positions(page)).toEqual([21, 22, 23, 24]);
  await turnRow(page, 2).locator(".group-toggle").click();
  await expect(turnRow(page, 2).locator(".group-toggle")).toHaveAttribute("aria-expanded", "true");
  expect(await positions(page)).toEqual([19, 20, 21, 22, 23, 24]);
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByTestId("context")).toContainText("Context at call 3");
  await expect(turnRow(page, 2).locator(".group-toggle")).toHaveAttribute("aria-expanded", "true");
  await page.locator("body").press("c");
  await page.locator("body").press("e");
  // Expand all opens the earlier turns too (the list is windowed, so their rows are checked by state).
  await expect(turnRow(page, 1).locator(".group-toggle")).toHaveAttribute("aria-expanded", "true");
});

test("only new in this call shows the blocks added since the previous call", async ({ page, engine }) => {
  await open(page, `${await engine.sessionUrl("resume")}?call=4`);
  const toggle = page.getByTestId("only-new");
  await expect(toggle).toHaveText(/^Only new( in this call)? 3$/);
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  expect(await positions(page)).toEqual([22, 23, 24]);
  await expect(page.locator('[data-section="tools"]')).toHaveCount(0);
  await toggle.click();
  expect(await positions(page)).toEqual([21, 22, 23, 24]);
});

test("a search, and a link to a block, open the earlier turn that holds it", async ({ page, engine }) => {
  const url = await engine.sessionUrl("resume");
  await open(page, `${url}?call=4`);
  await page.getByTestId("block-find").fill("Summarise @notes");
  await expect(turnRow(page, 1).locator(".group-toggle")).toHaveAttribute("aria-expanded", "true");
  expect(await positions(page)).toEqual([16]);
  await page.getByTestId("block-find").fill("");
  await expect(turnRow(page, 1)).toHaveCount(0);
  const ctx = await (await page.request.get(`${url.replace("/s/", "/api/v1/sessions/")}/calls/3/context`)).json();
  const hash = ctx.blocks.find((b: { position: number }) => b.position === 18).hash;
  await open(page, `${url}?call=4&block=${hash}`);
  await expect(turnRow(page, 1).locator(".group-toggle")).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator('[data-testid="block-row"][data-pos="18"]')).toBeVisible();
});
