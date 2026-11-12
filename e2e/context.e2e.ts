import type { Page } from "@playwright/test";
import { expect, test } from "./engine.ts";

/** Scroll the windowed block list to its end, so its last rows are drawn. */
async function scrollBlocksToEnd(page: Page) {
  await page.locator(".block-scroll").evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
}

test("the context at call N shows the hidden part, the bar and the blocks by section", async ({ page, engine }) => {
  await page.goto(`${await engine.sessionUrl("basic-tools")}?call=4`);
  const context = page.getByTestId("context");
  await expect(context).toContainText("Context at call 4");
  await expect(page.getByTestId("hidden-part")).toContainText("hidden part");
  await expect(page.getByTestId("context-bar").locator(".ctx-seg").first()).toBeVisible();
  const list = page.getByTestId("block-list");
  await expect(list).toContainText("Tool definitions");
  await expect(list).toContainText("Hidden from the chat");
  await expect(page.getByTestId("block-row").first()).toContainText("Tool schema");
});

test("stepping to another call loads its context", async ({ page, engine }) => {
  await page.goto(`${await engine.sessionUrl("basic-tools")}?call=4`);
  await expect(page.getByTestId("context")).toContainText("Context at call 4");
  await page.keyboard.press("ArrowRight");
  await expect(page.getByTestId("context")).toContainText("Context at call 5");
});

test("a deferred MCP tool schema is marked, and a block opens with its full text", async ({ page, engine }) => {
  await page.goto(`${await engine.sessionUrl("mcp-deferred")}?call=3`);
  await expect(page.getByTestId("block-row").first()).toBeVisible();
  await scrollBlocksToEnd(page);
  const deferred = page.getByTestId("block-row").filter({ has: page.locator(".tag.deferred") });
  await expect(deferred.first()).toContainText("MCP dictionary");
  await deferred.first().locator(".block-main").click();
  const panel = page.getByTestId("block-panel");
  await expect(panel).toContainText("deferred tool");
  await expect(panel.getByTestId("block-text")).toContainText("lookup_word");
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
});

test("a tool result that holds an image shows the image from the engine", async ({ page, engine }) => {
  await page.goto(await engine.sessionUrl("image"));
  await expect(page.getByTestId("block-row").first()).toBeVisible();
  await scrollBlocksToEnd(page);
  const image = page
    .getByTestId("block-row")
    .filter({ has: page.locator(".kind", { hasText: /^Tool result$/ }) })
    .filter({ hasText: "diagram.png" })
    .first();
  await image.locator(".block-main").click();
  const img = page.getByTestId("block-panel").locator("img");
  await expect(img).toBeVisible();
  expect(await img.evaluate((el) => (el as unknown as { naturalWidth: number }).naturalWidth)).toBeGreaterThan(0);
});
