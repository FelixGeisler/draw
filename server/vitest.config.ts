import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: ["test/setup.ts"],
    // Run the suite in the DEPLOYMENT timezone, not the runner's (PR #206
    // review). User-day logic — streaks, History buckets, the recurrence
    // schedule — is only exercised where the local and UTC days can differ:
    // on a UTC runner (GitHub's default) the DST regression that #205 fixed
    // passes against the buggy arithmetic, and a UTC-anchored occurrence
    // looks identical to a local-day one. Europe/Berlin has a +1/+2 offset
    // and both DST transitions, so those cases bite here and in CI.
    env: { TZ: "Europe/Berlin" },
    // Each test file gets its own process → own DATA_DIR → own SQLite database.
    isolate: true,
    pool: "forks",
    testTimeout: 15_000,
  },
});
