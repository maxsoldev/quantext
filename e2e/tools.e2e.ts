import { expect, test } from "./engine.ts";

test("tool calls are sorted by their total lifetime cost; the sort is in the URL", async ({ page, engine }) => {
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

test("each row prices the tool call's input next to its output, and either can sort", async ({ page, engine }) => {
  await page.goto(`${await engine.sessionUrl("basic-tools")}/tools`);
  const table = page.getByRole("table", { name: "Tool calls" });
  for (const name of ["Input tokens", "Output tokens", "Kept in", "Input cost", "Output cost", "Total"]) {
    await expect(table.getByRole("columnheader", { name, exact: true })).toBeVisible();
  }
  const rows = page.getByTestId("tool-row");
  const usd = async (row: number, id: string) =>
    Number((await rows.nth(row).getByTestId(id).textContent())?.replace("$", ""));
  // The total is the input's cost plus the output's (to the digits shown).
  const [input, output, total] = [await usd(0, "input-cost"), await usd(0, "output-cost"), await usd(0, "total-cost")];
  expect(Math.abs(input + output - total)).toBeLessThanOrEqual(total * 0.05);
  await expect(page.getByTestId("tool-calls")).toContainText("the calls themselves (their input)");
  await page.getByRole("button", { name: "Input cost", exact: true }).click();
  await expect(page).toHaveURL(/sort=input-cost/);
  const costs: number[] = [];
  for (let i = 0; i < 9; i++) costs.push(await usd(i, "input-cost"));
  expect(costs).toEqual([...costs].sort((a, b) => b - a));
  await page.getByRole("button", { name: "Output cost", exact: true }).click();
  await expect(page).toHaveURL(/sort=cost/);
  await expect(rows.first()).toContainText("big.txt");
  await rows.first().getByTestId("input-cost").getByRole("button").focus();
  await expect(page.getByTestId("tooltip")).toContainText("The tool call's input:");
});
