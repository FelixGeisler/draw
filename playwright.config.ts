import { defineConfig } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// E2E runs against its own server instance on separate ports with a
// throwaway database — a live dev server on 3001/5173 is not disturbed.
const E2E_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "draw-e2e-"));

export default defineConfig({
  testDir: "e2e",
  timeout: 30_000,
  // Journey tests share one database — a mid-journey retry would duplicate
  // state and break later steps. Fail fast instead.
  retries: 0,
  workers: 1,
  // The html report is what CI uploads as the failure artifact.
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: "http://localhost:5273",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npm run dev",
    // Health-check through the Vite proxy so both processes must be up.
    url: "http://localhost:5273/api/health",
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      DATA_DIR: E2E_DATA_DIR,
      API_PORT: "3101",
      VITE_PORT: "5273",
      ANTHROPIC_API_KEY: "", // E2E always runs AI-degraded
    },
  },
});
