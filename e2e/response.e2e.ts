import { appendRest, expect, startEngine, test } from "./engine.ts";

// basic-tools: line 58 is the last request; lines 59-60 are its answer (reasoning, then text).
const BEFORE_ANSWER = 58;

test("the latest call's response appears live once the harness writes it", async ({ page }) => {
  const engine = await startEngine({ scenarios: ["basic-tools"], firstLines: { "basic-tools": BEFORE_ANSWER } });
  try {
    await page.goto(await engine.sessionUrl("basic-tools"));
    const response = page.getByTestId("response");
    await expect(response).toContainText("Response of call 8");
    await expect(response).toContainText("The answer is not in the log yet");
    appendRest(engine, "basic-tools", BEFORE_ANSWER);
    const text = response.getByTestId("response-text");
    await expect(text).toContainText("The edit and the two step 7 reads");
    // Line breaks stay: the text starts with "done" on a line of its own.
    expect(await text.locator("p").first().innerText()).toMatch(/^done\n/);
    await expect(response).toContainText("It ended its turn.");
    await expect(response).toContainText("The next call will send this answer back as input.");
    const reasoning = response.locator("details.response-reasoning");
    await expect(reasoning).not.toHaveAttribute("open", "");
    await expect(reasoning).toContainText("Reasoning: omitted");
  } finally {
    await engine.stop();
  }
});

test("a tool call in a response opens its row on the tool calls page", async ({ page, engine }) => {
  await page.goto(`${await engine.sessionUrl("basic-tools")}?call=7`);
  const response = page.getByTestId("response");
  await expect(response).toContainText("Response of call 7");
  const tools = response.getByTestId("response-tool");
  await expect(tools).toHaveCount(3);
  await expect(response).toContainText("Call 8 sends it back as input.");
  await tools.first().getByRole("link", { name: "Open tool call" }).click();
  await expect(page).toHaveURL(/\/tools\?tool=/);
  await expect(page.getByTestId("tool-panel")).toBeVisible();
});
