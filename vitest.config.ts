import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  // The mod's tests import claude-code/testing and run under `claude plugin test` (pnpm test:mod).
  test: { exclude: [...configDefaults.exclude, "packages/mod/**"] },
});
