import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["lcov", "text-summary"],
      // Ratchet thresholds, set just below current coverage so regressions
      // fail CI without blocking unrelated work (AUDIT.md Tests). SFU
      // coverage is lower because mediasoup worker lifecycle is not unit
      // testable without native workers.
      thresholds: {
        lines: 45,
        statements: 45,
        functions: 55,
        branches: 50,
      },
    },
  },
});
