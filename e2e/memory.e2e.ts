import { expect, test } from "./engine.ts";

test("a project's memory: the index first, its links, and a new file as the harness writes it", async ({
  page,
  engine,
}) => {
  engine.writeMemory("basic-tools", "MEMORY.md", "- [Style](style.md) — how we write\n");
  engine.writeMemory("basic-tools", "style.md", "Use short sentences.\n");
  await page.goto(await engine.sessionUrl("basic-tools"));
  await page.getByRole("link", { name: "Project memory" }).click();
  const files = page.getByTestId("memory-file");
  await expect(files).toHaveCount(2);
  await expect(files.first()).toContainText("MEMORY.md");
  await page.getByRole("button", { name: "Style", exact: true }).click();
  await expect(page).toHaveURL(/file=style.md/);
  await expect(page.getByTestId("memory-content")).toContainText("Use short sentences.");
  engine.writeMemory("basic-tools", "testing.md", "Run the tests first.\n");
  await expect(files).toHaveCount(3, { timeout: 10_000 });
});
