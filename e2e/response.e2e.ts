import { appendRest, expect, startEngine, test } from "./engine.ts";

// basic-tools: line 58 is the last request; lines 59-60 are its answer (reasoning, then text).
const BEFORE_ANSWER = 58;

/** Scroll the windowed block list to its end, where the Output section is, until its note is drawn. */
async function toOutput(page: import("@playwright/test").Page, text = "") {
  await expect(async () => {
    await page.locator(".block-scroll").evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await expect(page.getByTestId("output-note")).toContainText(text, { timeout: 200 });
  }).toPass();
}

test("the latest call's Output section appears live once the harness writes the answer", async ({ page }) => {
  const engine = await startEngine({ scenarios: ["basic-tools"], firstLines: { "basic-tools": BEFORE_ANSWER } });
  try {
    await page.goto(await engine.sessionUrl("basic-tools"));
    await toOutput(page);
    const output = page.locator('[data-section="output"]');
    await expect(output).toContainText("Output — what the model answered");
    await expect(page.getByTestId("output-note")).toContainText("The answer is not in the log yet");
    appendRest(engine, "basic-tools", BEFORE_ANSWER);
    await toOutput(page, "It ended its turn.");
    const rows = page.getByTestId("output-row");
    await expect(rows.filter({ hasText: "The edit and the two step 7 reads" })).toBeVisible();
    await expect(rows.first()).toContainText("Reasoning");
    await expect(rows.first()).toContainText("omitted");
    await expect(page.getByTestId("output-note")).toContainText("It ended its turn.");
    await expect(page.getByTestId("output-note")).toContainText("The next call sends it again as input");
    // The answer's text opens in the block panel, as the output of the call.
    await rows.filter({ hasText: "The edit and the two step 7 reads" }).locator(".block-main").click();
    const panel = page.getByTestId("block-panel");
    await expect(panel).toContainText("Output of call 8");
    expect(await panel.getByTestId("block-text").innerText()).toMatch(/^done\n/);
  } finally {
    await engine.stop();
  }
});

test("the output is priced as output, apart from the input, and links to its tool calls", async ({ page, engine }) => {
  await page.goto(`${await engine.sessionUrl("basic-tools")}?call=7`);
  await toOutput(page);
  const head = page.locator('[data-section="output"]');
  await expect(head).toContainText("Output price");
  await expect(head).toContainText("3 blocks");
  const tools = page.getByTestId("output-row").filter({ hasText: "Tool call" });
  await expect(tools).toHaveCount(3);
  await expect(tools.first()).toContainText("Edit");
  await expect(tools.first()).toContainText("src/greet.ts");
  await tools.first().getByRole("link", { name: "Open tool call" }).click();
  await expect(page).toHaveURL(/\/tools\?tool=/);
  await expect(page.getByTestId("tool-panel")).toBeVisible();
});

test("an answer links to the call that sends it again, and that call's rows link back", async ({ page, engine }) => {
  await page.goto(`${await engine.sessionUrl("basic-tools")}?call=7`);
  await toOutput(page);
  await page.getByTestId("sent-again").click();
  await expect(page.getByTestId("context")).toContainText("Context at call 8");
  await toOutput(page);
  const back = page.getByTestId("response-of").filter({ hasText: "response of call 7" });
  await expect(back).toHaveCount(3);
  await back.first().click();
  await expect(page.getByTestId("context")).toContainText("Context at call 7");
});
