import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    globals: true,
    include: ["src/test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["lcov", "text-summary"],
      // Thresholds are a ratchet, not a goal: set just below the current
      // crypto coverage so regressions fail CI without blocking unrelated
      // work (AUDIT.md Tests). Raise them as coverage improves.
      thresholds: {
        lines: 70,
        statements: 70,
        functions: 70,
        branches: 60,
      },
    },
  },
});
