import { expect, test } from "./engine.ts";

test("a ? next to a key term opens the glossary at it, and Show me points at it in the UI", async ({
  page,
  engine,
}) => {
  await page.goto(`${await engine.sessionUrl("basic-tools")}?call=4`);
  await page.getByRole("button", { name: "What is system prompt and tool schemas?" }).click();
  const glossary = page.getByTestId("glossary");
  await expect(glossary).toBeVisible();
  await expect(page.locator("#term-hidden-part h3")).toBeFocused();
  await page.locator("#term-hidden-part").getByRole("button", { name: "Show me" }).click();
  await expect(glossary).toHaveCount(0);
  await expect(page.getByTestId("hidden-part")).toHaveClass(/pointed/);
});

test("Show me opens the view that holds the term", async ({ page, engine }) => {
  await page.goto(await engine.sessionUrl("basic-tools"));
  await page.keyboard.press("g");
  await page.locator("#term-lifetime-cost").getByRole("button", { name: "Show me" }).click();
  await expect(page).toHaveURL(/\/tools$/);
});

test("? shows the keyboard shortcuts; Escape closes them", async ({ page, engine }) => {
  await page.goto(await engine.sessionUrl("basic-tools"));
  await page.keyboard.press("Shift+?");
  const help = page.getByTestId("keys-help");
  await expect(help).toBeVisible();
  await expect(help).toContainText("Open the glossary");
  await page.keyboard.press("Escape");
  await expect(help).toHaveCount(0);
});

test("the glossary's facts about the cache are on the page", async ({ page, engine }) => {
  await page.goto(engine.url);
  await page.getByRole("button", { name: "Glossary" }).click();
  const g = page.getByTestId("glossary");
  await expect(g).toContainText("1.25× for a 5-minute entry, 2× for a 1-hour one");
  await expect(g).toContainText("Open a session to see it.");
});
