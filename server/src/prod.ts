import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  lanExposureWarning,
  resolveApiPort,
  resolveBackupIntervalHours,
  resolveBackupRetention,
  resolveHost,
  resolvePassword,
  resolveTrustProxy,
} from "./config.js";
import { startServer } from "./server.js";
import { startBackupScheduler } from "./backupScheduler.js";

// Production entry (#189, ADR-49): the same API as dev plus the built client,
// one port, run via tsx (`npm start`). A separate entry rather than NODE_ENV
// plumbing in index.ts because npm scripts cannot set env vars portably on
// Windows without another dependency. Imports are hoisted above this line,
// but Express only reads NODE_ENV when createApp() executes below.
process.env.NODE_ENV ??= "production";

// This is also the only entry that honors HOST — dev stays pinned to
// loopback (see config.ts).
const here = path.dirname(fileURLToPath(import.meta.url));
// CLIENT_DIR override: serve a build from elsewhere (a container mount), and
// the lever the fail-loud test below the default needs.
const clientDir = process.env.CLIENT_DIR
  ? path.resolve(process.env.CLIENT_DIR)
  : path.resolve(here, "../../client/dist");

// Fail loud and early: without index.html every page view would 404 (static
// mount and SPA fallback both point at the build output).
if (!fs.existsSync(path.join(clientDir, "index.html"))) {
  console.error(`[server] no client build at ${clientDir} — run \`npm run build\` first`);
  process.exit(1);
}

// The password gate (#190, ADR-50) is a prod-entry concern like HOST: dev
// serves the client through Vite, which the gate could never cover.
const password = resolvePassword();
if (password) {
  console.log("[server] password protection enabled (DRAW_PASSWORD)");
}

// LAN-exposure guardrail (#191, ADR-51): warn loudly when bound off loopback
// with no gate — the container sets HOST=0.0.0.0, so a passwordless LAN
// deployment must not go unnoticed. Non-fatal: HOST is a deliberate opt-in.
const host = resolveHost();
const exposureWarning = lanExposureWarning(host, password);
if (exposureWarning) {
  console.error(exposureWarning);
}

// TRUST_PROXY makes req.ip the de-proxied client so the login limiter keys on
// the real LAN client behind a reverse proxy (ADR-50). Prod-entry only, like
// HOST — dev never sits behind a proxy.
startServer(resolveApiPort(), {
  clientDir,
  host,
  password,
  trustProxy: resolveTrustProxy(),
});

// Scheduled automatic backups (#194, ADR-52): a prod-entry concern like HOST
// and DRAW_PASSWORD — the headless Pi deployment has no cron, so the timer
// lives in the server process. Off by default (interval unset/0): starts
// nothing, behavior unchanged. When configured, archives land in
// DATA_DIR/backups/ and restore is the existing POST /api/backup/import.
const backupIntervalHours = resolveBackupIntervalHours();
const backupRetention = resolveBackupRetention();
if (backupIntervalHours > 0) {
  console.log(
    `[server] scheduled backups every ${backupIntervalHours}h, keeping ${backupRetention} ` +
      `(DATA_DIR/backups; restore via POST /api/backup/import)`,
  );
  startBackupScheduler(backupIntervalHours, backupRetention);
}
