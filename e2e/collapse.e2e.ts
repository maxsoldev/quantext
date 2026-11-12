import type { Page } from "@playwright/test";
import { expect, test } from "./engine.ts";

const section = (page: Page, name: string) => page.locator(`[data-section="${name}"] .section-toggle`);
const expanded = (page: Page, name: string) => section(page, name).getAttribute("aria-expanded");

async function open(page: Page, url: string) {
  await page.goto(url);
  await expect(page.getByTestId("block-row").first()).toBeVisible();
}

test("by default the hidden part is folded, the messages and the output are open, parts are folded", async ({
  page,
  engine,
}) => {
  await open(page, `${await engine.sessionUrl("basic-tools")}?call=1`);
  expect(await expanded(page, "tools")).toBe("false");
  expect(await expanded(page, "system")).toBe("false");
  expect(await expanded(page, "messages")).toBe("true");
  // A folded section is one row that sums it up.
  await expect(page.locator('[data-section="tools"]')).toContainText(/\d+ blocks, [\d.]+% of the input/);
  await expect(page.locator('[data-section="tools"]')).toContainText(/cached|new/i);
  await expect(page.getByTestId("block-row").filter({ hasText: "Tool schema" })).toHaveCount(0);
  await expect(page.getByTestId("part-row")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Show the 7 parts of block/ })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
});

test("Enter on a section header opens it; expand all and collapse all, by button and by key", async ({
  page,
  engine,
}) => {
  await open(page, `${await engine.sessionUrl("basic-tools")}?call=1`);
  await section(page, "tools").focus();
  await page.keyboard.press("Enter");
  expect(await expanded(page, "tools")).toBe("true");
  await expect(section(page, "tools")).toHaveAttribute("aria-controls", "fold-tools");
  await expect(page.locator("#fold-tools")).toContainText("Tool schema");
  await page.getByTestId("collapse-all").click();
  for (const s of ["tools", "system", "messages"]) expect(await expanded(page, s)).toBe("false");
  await expect(page.getByTestId("block-row")).toHaveCount(0);
  await page.locator("body").press("e");
  for (const s of ["tools", "system", "messages"]) expect(await expanded(page, s)).toBe("true");
  await expect(page.getByTestId("category-toggle").first()).toHaveAttribute("aria-expanded", "true");
  await page.locator("body").press("c");
  expect(await expanded(page, "messages")).toBe("false");
  await page.getByTestId("expand-all").click();
  expect(await expanded(page, "system")).toBe("true");
  await page.keyboard.press("?");
  await expect(page.getByTestId("keys-help")).toContainText("Expand all sections");
});

test("what is open stays so on the next call and after a reload", async ({ page, engine }) => {
  await open(page, `${await engine.sessionUrl("basic-tools")}?call=2`);
  await section(page, "tools").click();
  await section(page, "messages").click();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByTestId("context")).toContainText("Context at call 3");
  expect(await expanded(page, "tools")).toBe("true");
  expect(await expanded(page, "messages")).toBe("false");
  await page.reload();
  await expect(page.getByTestId("context")).toContainText("Context at call 3");
  expect(await expanded(page, "tools")).toBe("true");
  expect(await expanded(page, "messages")).toBe("false");
});

test("a search finds blocks in a folded section and opens it while it is typed", async ({ page, engine }) => {
  await open(page, `${await engine.sessionUrl("basic-tools")}?call=1`);
  await page.getByTestId("block-find").fill("tool schema");
  await expect(page.getByTestId("block-row").first()).toContainText("Tool schema");
  expect(await expanded(page, "tools")).toBe("true");
  await page.getByTestId("block-find").fill("");
  expect(await expanded(page, "tools")).toBe("false");
});

test("a link to a block in a folded section opens the section at the block", async ({ page, engine }) => {
  const url = await engine.sessionUrl("basic-tools");
  await open(page, `${url}?call=1`);
  const [, log, id] = /\/s\/(\d+)\/([^?]+)/.exec(url) ?? [];
  const ctx = (await (await page.request.get(`${engine.url}/api/v1/sessions/${log}/${id}/calls/0/context`)).json()) as {
    blocks: { section: string; hash?: string }[];
  };
  const hash = ctx.blocks.find((b) => b.section === "system")?.hash;
  await page.goto(`${url}?call=1&block=${hash}`);
  await expect(page.getByTestId("block-panel")).toBeVisible();
  expect(await expanded(page, "system")).toBe("true");
});

test("a category of the token shares folds its parts, and opens them in the list too", async ({ page, engine }) => {
  await open(page, `${await engine.sessionUrl("basic-tools")}?call=1`);
  await expect(page.getByTestId("part-total")).toHaveCount(0);
  const toggle = page.getByTestId("category-toggle").first();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.click();
  await expect(page.getByTestId("part-total").filter({ hasText: "Skill listing" })).toBeVisible();
  await expect(page.locator('[data-part="Skill listing"]')).toBeVisible();
  // And back: folding the block in the list leaves the category as it is; the category folds both.
  await toggle.click();
  await expect(page.getByTestId("part-row")).toHaveCount(0);
  await page.getByRole("button", { name: /Show the 7 parts of block/ }).click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
});
