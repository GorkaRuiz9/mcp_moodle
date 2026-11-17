import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/e2e/*.test.ts"],
    // The tests share one Moodle and build on each other's changes.
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
