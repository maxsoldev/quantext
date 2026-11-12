import type { Page } from "@playwright/test";
import { expect, test } from "./engine.ts";

/** Top and bottom of an element in the viewport. */
async function box(page: Page, selector: string) {
  const b = await page.locator(selector).first().boundingBox();
  if (!b) throw new Error(`no ${selector}`);
  return { top: b.y, bottom: b.y + b.height };
}

test.describe("on a 1280x720 projector", () => {
  test.use({ viewport: { width: 1280, height: 720 } });

  test("the scrubber hides no part of the chart, and each legend sits by its panel", async ({ page, engine }) => {
    await page.goto(`${await engine.sessionUrl("basic-tools")}?call=4`);
    const scrubber = await box(page, ".scrubber");
    expect((await box(page, "[data-testid=timeline]")).bottom).toBeLessThanOrEqual(scrubber.top);
    const heads = page.locator(".panel-head");
    await expect(heads.nth(0)).toContainText("What the context holds");
    await expect(heads.nth(0).getByLabel("Context categories")).toBeVisible();
    await expect(heads.nth(1)).toContainText("How the input was billed");
    await expect(heads.nth(1).getByLabel("Billing parts")).toBeVisible();
    // One row each: no wrap on this fixture.
    for (const i of [0, 1]) expect((await heads.nth(i).boundingBox())?.height).toBeLessThan(30);
  });

  test("the chart, the context bar and what changed are visible together", async ({ page, engine }) => {
    await page.goto(`${await engine.sessionUrl("basic-tools")}?call=4`);
    await expect(page.getByTestId("context-bar")).toBeVisible();
    await page.evaluate(`document.querySelector(".timeline-card")?.scrollIntoView({ block: "start" })`);
    const header = await box(page, "header");
    const scrubber = await box(page, ".scrubber");
    for (const s of ["[data-testid=timeline]", "[data-testid=context-bar]", "[data-testid=strip-now]"]) {
      const b = await box(page, s);
      expect(b.top, s).toBeGreaterThanOrEqual(header.bottom);
      expect(b.bottom, s).toBeLessThanOrEqual(scrubber.top);
    }
  });
});

test.describe("on a 1440x900 screen", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("the whole chart is above the scrubber, with the session head in view", async ({ page, engine }) => {
    await page.goto(`${await engine.sessionUrl("basic-tools")}?call=4`);
    await expect(page.getByTestId("timeline")).toBeVisible();
    expect((await box(page, "[data-testid=timeline]")).bottom).toBeLessThanOrEqual((await box(page, ".scrubber")).top);
    expect((await box(page, ".session-head")).top).toBeGreaterThanOrEqual(0);
  });
});
