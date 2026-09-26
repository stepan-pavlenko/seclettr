import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: ["src/test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["lcov", "text-summary"],
      // Ratchet thresholds, set just below current coverage so regressions
      // fail CI without blocking unrelated work (AUDIT.md Tests). The
      // functions floor is intentionally low: many exported type-guard
      // helpers are only exercised transitively.
      thresholds: {
        lines: 85,
        statements: 85,
        functions: 20,
        branches: 75,
      },
    },
  },
});
