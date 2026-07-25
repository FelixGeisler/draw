import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveApiPort } from "./config.js";
import { startServer } from "./server.js";

// Production entry (#189, ADR-49): the same API as dev plus the built client,
// one port, run via tsx (`npm start`). A separate entry rather than NODE_ENV
// plumbing in index.ts because npm scripts cannot set env vars portably on
// Windows without another dependency. Imports are hoisted above this line,
// but Express only reads NODE_ENV when createApp() executes below.
process.env.NODE_ENV ??= "production";

const here = path.dirname(fileURLToPath(import.meta.url));
const clientDir = path.resolve(here, "../../client/dist");

// Fail loud and early: without index.html every page view would 404 (static
// mount and SPA fallback both point at the build output).
if (!fs.existsSync(path.join(clientDir, "index.html"))) {
  console.error(`[server] no client build at ${clientDir} — run \`npm run build\` first`);
  process.exit(1);
}

startServer(resolveApiPort(), { clientDir });
