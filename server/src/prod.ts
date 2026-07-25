import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveApiPort, resolveHost, resolvePassword } from "./config.js";
import { startServer } from "./server.js";

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

startServer(resolveApiPort(), { clientDir, host: resolveHost(), password });
