import { configDefaults, defineConfig } from "vitest/config";

// Load tests measure time, and take most of the CPU while they run. Beside the unit tests they made unit tests
// pass vitest's 5 s timeout on slow CI runners, and their own numbers noisy. So `pnpm test` runs `unit` (files in
// parallel) and then `perf` (one file at a time, nothing beside it).
const PERF = [
  "packages/engine/test/query/performance.test.ts",
  "packages/engine/test/ingest/performance.test.ts",
  "packages/engine/test/api/latency.test.ts",
];

export default defineConfig({
  test: {
    // The mod's tests import claude-code/testing and run under `claude plugin test` (pnpm test:mod).
    exclude: [...configDefaults.exclude, "packages/mod/**"],
    projects: [
      { extends: true, test: { name: "unit", exclude: PERF } },
      { extends: true, test: { name: "perf", include: PERF, fileParallelism: false } },
    ],
  },
});
