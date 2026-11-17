import { defineConfig } from "vitest/config";

// `npm test`: fast unit tests against a simulated Moodle. The end-to-end
// tests need a local Moodle in Docker and run with `npm run test:e2e`.
export default defineConfig({
  test: {
    include: ["tests/*.test.ts"],
  },
});
