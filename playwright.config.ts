import { defineConfig } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// E2E runs against its own server instance on separate ports with a
// throwaway database — a live dev server on 3001/5173 is not disturbed.
// E2E_API_PORT/E2E_VITE_PORT let parallel checkouts (worktrees, CI shards)
// run their E2E suites side by side without colliding on the defaults. The
// E2E_ prefix keeps an ambient API_PORT from a dev shell out of E2E isolation.
const E2E_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "draw-e2e-"));
const API_PORT = process.env.E2E_API_PORT || "3101";
const VITE_PORT = process.env.E2E_VITE_PORT || "5273";

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
    baseURL: `http://localhost:${VITE_PORT}`,
    trace: "retain-on-failure",
  },
  // API and client are separate webServer entries (not one `npm run dev`) so
  // that EACH port gets Playwright's pre-flight availability check. A single
  // entry only checked the Vite URL: with a foreign checkout's API server on
  // E2E_API_PORT our server died on EADDRINUSE, Vite still came up and proxied
  // /api to the foreign process, and the suite silently ran against the wrong
  // build (#70). reuseExistingServer stays false on both — every run needs its
  // own throwaway DATA_DIR, so an already-listening server is never ours; with
  // false, Playwright fails fast with "... is already used" instead.
  webServer: [
    {
      command: "npm run dev -w server",
      url: `http://127.0.0.1:${API_PORT}/api/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        DATA_DIR: E2E_DATA_DIR,
        API_PORT,
        ANTHROPIC_API_KEY: "", // E2E always runs AI-degraded
      },
    },
    {
      command: "npm run dev -w client",
      // Health-check through the Vite proxy so the proxy wiring to the API
      // must work too, not just the static dev server.
      url: `http://localhost:${VITE_PORT}/api/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        VITE_PORT,
        API_PORT, // proxy target (client/vite.config.ts)
      },
    },
  ],
});
