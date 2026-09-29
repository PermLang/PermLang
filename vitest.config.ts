import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Building a ts-morph project with @types/node takes a few seconds.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
