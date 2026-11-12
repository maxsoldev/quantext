import type { Page } from "@playwright/test";
import { expect, test } from "./engine.ts";

/** Open call 1 of basic-tools, with the block list scrolled to the merged block, so its windowed rows are drawn. */
async function openFirstCall(page: Page, url: string) {
  await page.goto(`${url}?call=1`);
  await expect(page.getByTestId("block-row").first()).toBeVisible();
  await page.locator(".block-scroll").evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
}

test("the merged injected block lists its attached texts as parts, with tokens and cache state", async ({
  page,
  engine,
}) => {
  await openFirstCall(page, await engine.sessionUrl("basic-tools"));
  const block = page.getByTestId("block-row").filter({ hasText: "7 attached texts" });
  await expect(block).toContainText("System");
  const parts = page.getByTestId("part-row");
  for (const label of ["Environment", "Deferred tools", "Agent listing", "Skill listing", "Date"]) {
    await expect(parts.filter({ hasText: label }).first()).toBeVisible();
  }
  const skills = page.locator('[data-part="Skill listing"]');
  await expect(skills).toContainText("~"); // an estimate
  await expect(skills).toContainText(/Cached|New/);
  await expect(page.getByTestId("part-total").filter({ hasText: "Skill listing" })).toBeVisible();
});

test("a search for skill finds the skill listing; its explainer says what it costs on every call", async ({
  page,
  engine,
}) => {
  await page.goto(`${await engine.sessionUrl("basic-tools")}?call=1`);
  await page.getByTestId("block-find").fill("listing");
  await expect(page.getByTestId("glossary")).toHaveCount(0); // typing "g" in the box is no shortcut
  await page.getByTestId("block-find").fill("skill");
  await expect(page.getByRole("status")).toContainText(/\d+ of \d+ blocks/);
  const skills = page.locator('[data-part="Skill listing"]');
  await expect(skills).toBeVisible();
  await expect(page.locator('[data-part="Environment"]')).toHaveCount(0);
  await expect(skills.locator(".part-main")).toHaveAttribute(
    "data-tip",
    /Sent on every call\. Costs [\d,]+ tokens here\./,
  );
  await skills.getByRole("button", { name: "What is skill listing?" }).click();
  await expect(page.locator("#term-skill-listing")).toContainText("every later call sends it again");
});

test("a part opens its block at that part", async ({ page, engine }) => {
  await openFirstCall(page, await engine.sessionUrl("basic-tools"));
  await page.locator('[data-part="Deferred tools"] .part-main').click();
  const text = page.getByTestId("block-panel").getByTestId("block-text");
  await expect(text.locator(".part-head").filter({ hasText: "Deferred tools" })).toBeInViewport();
  await expect(text).toContainText("Skill listing, ");
});
