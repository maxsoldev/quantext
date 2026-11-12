import { expect, test } from "./engine.ts";

test("tool calls are sorted by lifetime cost; the sort is in the URL", async ({ page, engine }) => {
  await page.goto(await engine.sessionUrl("basic-tools"));
  await page.getByRole("link", { name: "Tool calls" }).click();
  await expect(page).toHaveURL(/\/tools$/);
  const rows = page.getByTestId("tool-row");
  await expect(rows).toHaveCount(9);
  // The big file read stays in five calls: the most expensive output.
  await expect(rows.first()).toContainText("big.txt");
  await expect(page.getByTestId("tool-calls")).toContainText("9 tool calls");
  await page.getByRole("button", { name: "Order run" }).click();
  await expect(page).toHaveURL(/sort=time/);
  await expect(rows.first()).toContainText("find src");
  await expect(rows.filter({ hasText: "missing.txt" })).toContainText("Error");
});

test("an Edit shows its change, and a link opens its output in the context", async ({ page, engine }) => {
  await page.goto(`${await engine.sessionUrl("basic-tools")}/tools`);
  await page.getByRole("button", { name: /Open the tool call: Edit/ }).click();
  const panel = page.getByTestId("tool-panel");
  await expect(panel.locator(".diff-del")).toContainText("Hello");
  await expect(panel.locator(".diff-add")).toContainText("Hi");
  await panel.getByRole("link", { name: /Open its output/ }).click();
  await expect(page).toHaveURL(/call=8$/);
  await expect(page.getByTestId("block-panel")).toContainText("Tool result");
});

test("an Agent tool call drills down into the subagent's own session", async ({ page, engine }) => {
  await page.goto(`${await engine.sessionUrl("subagent")}/tools`);
  await page.getByRole("button", { name: /Open the tool call: Agent/ }).click();
  await page.getByTestId("subagent-link").click();
  await expect(page).toHaveURL(/agent-/);
  await expect(page.getByTestId("timeline")).toBeVisible();
  await expect(page.getByTestId("call-position")).toContainText("Call 3");
});
