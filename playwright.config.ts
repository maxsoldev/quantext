/**
 * End-to-end tests of the viewer (`pnpm e2e`): each test file starts the bundled engine (`dist/engine.js`, so run
 * `pnpm build` first; `pnpm e2e` does) over a temp copy of the fixtures. Files end in `.e2e.ts`, so neither
 * Vitest nor `bun test` picks them up.
 */
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  testMatch: "**/*.e2e.ts",
  fullyParallel: false,
  workers: 2,
  timeout: 30_000,
  reporter: [["list"]],
  use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 }, trace: "retain-on-failure" },
  outputDir: "node_modules/.cache/playwright",
});
