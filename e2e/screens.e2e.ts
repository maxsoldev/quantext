/**
 * The fixture screenshots in docs/screens: `QX_SCREENS=1 pnpm exec playwright test e2e/screens.e2e.ts` (after
 * `pnpm build`). Skipped otherwise. Fixtures only, light theme (the projector theme).
 */
import { join } from "node:path";
import type { Page } from "@playwright/test";
import type { Engine } from "./engine.ts";
import { expect, test } from "./engine.ts";

const OUT = join(import.meta.dirname, "..", "docs", "screens");
const SIZES = [
  { width: 1440, height: 900 },
  { width: 1280, height: 720 },
] as const;

test.skip(!process.env.QX_SCREENS, "set QX_SCREENS=1 to take the screenshots");

type Shot = { name: string; both: boolean; go: (page: Page, engine: Engine) => Promise<void> };

const SHOTS: Shot[] = [
  {
    name: "sessions",
    both: true,
    go: async (page, engine) => {
      await page.goto(engine.url);
      await expect(page.getByTestId("session-row").first()).toBeVisible();
    },
  },
  {
    name: "session",
    both: true,
    go: async (page, engine) => {
      await page.goto(`${await engine.sessionUrl("basic-tools")}?call=4`);
      await expect(page.getByTestId("timeline")).toBeVisible();
    },
  },
  {
    // The chart, the context bar and the strips together: the timeline card scrolled to the top.
    name: "call",
    both: true,
    go: async (page, engine) => {
      await page.goto(`${await engine.sessionUrl("basic-tools")}?call=4`);
      await expect(page.getByTestId("context-bar")).toBeVisible();
      await page.evaluate(`document.querySelector(".timeline-card")?.scrollIntoView({ block: "start" })`);
    },
  },
  {
    name: "context",
    both: true,
    go: async (page, engine) => {
      await page.goto(`${await engine.sessionUrl("basic-tools")}?call=3`);
      await page.getByTestId("context").scrollIntoViewIfNeeded();
      await page.evaluate(`document.getElementById("context-title")?.scrollIntoView({ block: "start" })`);
    },
  },
  {
    // The skill listing found by a search: a part of the merged injected block, and its total under the category.
    name: "parts",
    both: true,
    go: async (page, engine) => {
      await page.goto(`${await engine.sessionUrl("basic-tools")}?call=1`);
      await page.getByTestId("block-find").fill("skill");
      await expect(page.locator('[data-part="Skill listing"]')).toBeVisible();
      await page.evaluate(`document.getElementById("context-title")?.scrollIntoView({ block: "start" })`);
    },
  },
  {
    // Call 7's answer as the Output section, at the end of the block list: three tool calls, priced as output.
    name: "output",
    both: true,
    go: async (page, engine) => {
      await page.goto(`${await engine.sessionUrl("basic-tools")}?call=7`);
      await expect(page.getByTestId("block-row").first()).toBeVisible();
      await page.locator(".block-scroll").evaluate((el) => {
        el.scrollTop = el.scrollHeight;
      });
      await expect(page.getByTestId("output-note")).toBeVisible();
      await page.evaluate(`document.querySelector(".block-list")?.scrollIntoView({ block: "end" })`);
    },
  },
  {
    // The resumed session's last call: the earlier turns open, turn 2 open, the call's own turn below.
    name: "turns",
    both: true,
    go: async (page, engine) => {
      await page.goto(`${await engine.sessionUrl("resume")}?call=4`);
      await page.getByTestId("earlier-row").locator(".group-toggle").click();
      await page.locator('[data-testid="turn-row"][data-turn="2"] .group-toggle').click();
      await expect(page.locator('[data-testid="block-row"][data-pos="19"]')).toBeVisible();
      await page.evaluate(`document.querySelector(".block-list")?.scrollIntoView({ block: "start" })`);
    },
  },
  {
    name: "block-panel",
    both: false,
    go: async (page, engine) => {
      await page.goto(`${await engine.sessionUrl("basic-tools")}?call=3`);
      await page.getByTestId("block-row").first().getByRole("button").first().click();
      await expect(page.getByTestId("block-text")).toBeVisible();
    },
  },
  {
    name: "diff",
    both: true,
    go: async (page, engine) => {
      await page.goto(`${await engine.sessionUrl("compaction")}?call=5`);
      await expect(page.getByTestId("break-note")).toBeVisible();
      await page.evaluate(`document.getElementById("what-changed")?.scrollIntoView({ block: "start" })`);
    },
  },
  {
    name: "tools",
    both: true,
    go: async (page, engine) => {
      await page.goto(`${await engine.sessionUrl("basic-tools")}/tools`);
      await expect(page.getByTestId("tool-row").first()).toBeVisible();
    },
  },
  {
    name: "tool-edit",
    both: false,
    go: async (page, engine) => {
      await page.goto(`${await engine.sessionUrl("basic-tools")}/tools`);
      await page.getByRole("button", { name: /Open the tool call: Edit/ }).click();
      await expect(page.getByTestId("edit-diff")).toBeVisible();
    },
  },
  {
    name: "compaction",
    both: true,
    go: async (page, engine) => {
      await page.goto(`${await engine.sessionUrl("compaction")}/compactions`);
      await expect(page.getByTestId("compaction")).toBeVisible();
    },
  },
  {
    name: "memory",
    both: false,
    go: async (page, engine) => {
      engine.writeMemory(
        "basic-tools",
        "MEMORY.md",
        "- [Style](style.md) — how we write\n- [Tests](tests.md) — run them first\n",
      );
      engine.writeMemory("basic-tools", "style.md", "---\nname: style\n---\nShort sentences. One idea each.\n");
      engine.writeMemory("basic-tools", "tests.md", "---\nname: tests\n---\nRun the unit tests before a commit.\n");
      await page.goto(await engine.sessionUrl("basic-tools"));
      await page.getByRole("link", { name: "Project memory" }).click();
      // The engine is shared per worker and all fixtures share one memory folder, so wait for these three files
      // rather than an exact count (memory.e2e.ts adds its own).
      for (const name of ["MEMORY.md", "style.md", "tests.md"])
        await expect(page.getByTestId("memory-file").filter({ hasText: name })).toHaveCount(1);
    },
  },
  {
    name: "glossary",
    both: false,
    go: async (page, engine) => {
      await page.goto(`${await engine.sessionUrl("basic-tools")}?call=4`);
      await page.getByRole("button", { name: "What is prompt cache?" }).click();
      await expect(page.getByTestId("glossary")).toBeVisible();
    },
  },
];

for (const shot of SHOTS) {
  for (const size of shot.both ? SIZES : SIZES.slice(0, 1)) {
    test(`screenshot ${shot.name} at ${size.width}x${size.height}`, async ({ page, engine }) => {
      await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
      await page.setViewportSize(size);
      await shot.go(page, engine);
      await page.mouse.move(0, 0);
      await page.waitForTimeout(300);
      await page.screenshot({ path: join(OUT, `${shot.name}-${size.width}x${size.height}.png`) });
    });
  }
}
