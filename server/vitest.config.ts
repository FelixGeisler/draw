import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: ["test/setup.ts"],
    // Each test file gets its own process → own DATA_DIR → own SQLite database.
    isolate: true,
    pool: "forks",
    testTimeout: 15_000,
  },
});
