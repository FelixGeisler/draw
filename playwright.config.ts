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
const PROD_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "draw-e2e-prod-"));
const API_PORT = process.env.E2E_API_PORT || "3101";
const VITE_PORT = process.env.E2E_VITE_PORT || "5273";
// Production smoke (#189): the built client served by Express on one port.
// production-serve.spec.ts resolves the same env/default — importing it from
// here would re-run this module's mkdtemp side effects in the worker.
const PROD_PORT = process.env.E2E_PROD_PORT || "3102";

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
        // No HOST pin needed: the dev entry ignores HOST by design (#189).
        ANTHROPIC_API_KEY: "", // E2E always runs AI-degraded
        // OTA check (#247): point the release check at a closed loopback
        // port so "Check now" fails fast and deterministically — E2E must
        // never reach GitHub, and a failed check must never light the
        // update banner mid-suite.
        UPDATE_CHECK_URL: "http://127.0.0.1:9/draw-e2e-release",
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
    {
      // Production mode (#189): the documented commands verbatim — build the
      // real client bundle, then `npm start` serves it plus the API on one
      // port. Longer timeout: the health poll spans the vite build too.
      command: "npm run build && npm start",
      url: `http://127.0.0.1:${PROD_PORT}/api/health`,
      reuseExistingServer: false,
      timeout: 180_000,
      env: {
        DATA_DIR: PROD_DATA_DIR,
        API_PORT: PROD_PORT,
        // The prod entry DOES honor HOST — pin it so an ambient export
        // cannot move the health URL off 127.0.0.1.
        HOST: "",
        // Likewise DRAW_PASSWORD (#190): this entry is the NO-auth prod
        // smoke — an ambient secret (shell or server/.env) must not gate it.
        // lan-password.spec.ts boots its own protected server instead.
        DRAW_PASSWORD: "",
        ANTHROPIC_API_KEY: "", // E2E always runs AI-degraded
        // OTA check (#247): the prod entry is the one that starts the boot
        // check timer (~60s in) — pin its check URL off the network too, or
        // a long E2E run would fire a real GET at GitHub.
        UPDATE_CHECK_URL: "http://127.0.0.1:9/draw-e2e-release",
      },
    },
  ],
});
