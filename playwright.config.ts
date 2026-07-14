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
  use: {
    baseURL: "http://localhost:5273",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npm run dev",
    url: "http://localhost:5273",
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      DATA_DIR: E2E_DATA_DIR,
      API_PORT: "3101",
      VITE_PORT: "5273",
    },
  },
});
