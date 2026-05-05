import { defineConfig } from "vitest/config";

// Vitest scopes itself to `test/` and ignores Playwright e2e specs
// under `e2e/`. The default include pattern picks up both `.test.ts`
// and `.spec.ts`, so without an explicit include the Playwright-only
// `e2e/*.spec.ts` files crash with `test.describe() called outside
// of a Playwright runtime` errors.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["e2e/**", "node_modules/**", "dist/**"],
  },
});
