import path from "node:path";
import express from "express";
import { createAuth } from "./auth.js";
import { tasksRouter } from "./routes/tasks.js";
import { categoriesRouter } from "./routes/categories.js";
import { settingsRouter } from "./routes/settings.js";
import { drawRouter } from "./routes/draw.js";
import { timerRouter } from "./routes/timer.js";
import { statsRouter } from "./routes/stats.js";
import { activityRouter } from "./routes/activity.js";
import { gamificationRouter } from "./routes/gamification.js";
import { achievementsRouter } from "./routes/achievements.js";
import { goalsRouter } from "./routes/goals.js";
import { searchRouter } from "./routes/search.js";
import { createShopRouter } from "./routes/shop.js";
import { challengeRouter } from "./routes/challenge.js";
import { notifyRouter } from "./routes/notify.js";
import { updateRouter } from "./routes/update.js";
import { goalMaterialsRouter, materialsRouter } from "./routes/materials.js";
import { aiRouter } from "./routes/ai.js";
import { backupRouter } from "./routes/backup.js";
import { cardArtRouter } from "./routes/cardArt.js";
import { sweepBackupTemp } from "./services/backupService.js";
import { bindAgentToolApi } from "./services/agentService.js";
import { InProcessApiClient } from "./tools/inProcessApi.js";

export interface AppOptions {
  /**
   * Absolute path to a built client (client/dist). When set, the app serves
   * it statically with an SPA fallback — production mode (#189, ADR-49).
   * Dev keeps this unset: Vite serves the client and proxies /api here.
   */
  clientDir?: string;
  /**
   * Shared secret for the optional LAN password gate (#190, ADR-50). When
   * set, every /api route and static asset requires a session cookie or the
   * x-draw-password header; only /api/health and the login route stay open.
   * Unset: no auth anywhere — behavior identical to before #190.
   */
  password?: string;
  /**
   * Value for Express's `trust proxy` setting (#190, ADR-50). Makes `req.ip`
   * the de-proxied client address so the login rate limiter keys on the real
   * LAN client behind a reverse proxy, not the proxy itself. Falsy/unset
   * leaves Express's default (trust nobody).
   */
  trustProxy?: boolean | number | string;
}

export interface AppDependencies {
  /** Internal deterministic seam for in-process pack API tests. */
  shopRandom?: () => number;
}

export function createApp(options: AppOptions = {}, dependencies: AppDependencies = {}) {
  const app = express();
  // No framework fingerprint — LAN exposure is a supported configuration
  // since #189.
  app.disable("x-powered-by");
  // Behind a reverse proxy (ADR-50), de-proxy req.ip so the login limiter
  // throttles the real client, not the proxy. Off unless configured.
  if (options.trustProxy) {
    app.set("trust proxy", options.trustProxy);
  }
  app.use(express.json());

  // Boot hygiene (#103): drop temp artifacts a previous run was killed before
  // it could clean up (see sweepBackupTemp). Here rather than in startServer()
  // so it runs before the first request on every path that builds the app —
  // and it must run AFTER the backup router's import, which is what creates
  // the uploads directory the sweep empties.
  const swept = sweepBackupTemp();
  if (swept.length > 0) {
    console.log(`[backup] swept ${swept.length} orphaned temp artifact(s): ${swept.join(", ")}`);
  }

  // Deliberately ABOVE the password gate: Playwright's webServer pre-flight
  // and the container healthcheck (#191) poll it before anyone can log in,
  // and it leaks nothing but liveness and the server clock (ADR-50).
  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, time: new Date().toISOString() });
  });

  // Password gate (#190, ADR-50): the login route first (it must stay
  // reachable), then the gate as blanket middleware — everything mounted
  // below, /api routers and static client alike, requires a credential.
  if (options.password) {
    const { loginHandler, gate } = createAuth(options.password);
    app.post("/api/auth/login", loginHandler);
    app.use(gate);
  }

  app.use("/api/tasks", tasksRouter);
  app.use("/api/categories", categoriesRouter);
  app.use("/api/settings", settingsRouter);
  app.use("/api/draw", drawRouter);
  app.use("/api/timer", timerRouter);
  app.use("/api/stats", statsRouter);
  app.use("/api/activity", activityRouter);
  app.use("/api/gamification", gamificationRouter);
  app.use("/api/achievements", achievementsRouter);
  app.use("/api/shop", createShopRouter(dependencies.shopRandom ?? Math.random));
  app.use("/api/challenge", challengeRouter);
  app.use("/api/notify", notifyRouter);
  // OTA update surface (#247) — deliberately BELOW the gate: the running
  // version is authed data (ADR-50), and the apply endpoint restarts the app.
  app.use("/api/update", updateRouter);
  app.use("/api/goals", goalsRouter);
  // Palette search (#243, ADR-68): title search over tasks AND goals in one
  // round-trip — its own namespace, not a /api/tasks?q=: the payload is a
  // flat result-row shape, not the task projection.
  app.use("/api/search", searchRouter);
  app.use("/api/goals/:id/materials", goalMaterialsRouter);
  app.use("/api/materials", materialsRouter);
  app.use("/api/ai", aiRouter);
  app.use("/api/backup", backupRouter);
  // Cache-only batch art reads for the trophy pile (#114) — deliberately NOT
  // under /api/tasks/:id: the per-task route generates on miss, this never.
  app.use("/api/card-art", cardArtRouter);

  // The assistant's READ tools (#31, ADR-37) execute through the app's own
  // HTTP surface — a lazy private loopback listener on THIS app instance, so
  // every domain invariant and derived payload holds by construction (the
  // ADR-19 argument), with or without a public listener (supertest). The
  // gate's secret rides along: self-requests must pass the gate too (#190).
  bindAgentToolApi(new InProcessApiClient(app, options.password));

  // The API namespace speaks JSON — including its 404s: an unknown /api path
  // must never read as HTML, with or without a client mounted below. After
  // every /api router (they keep full precedence), before the static client.
  // app.use("/api", ...) matches case-insensitively, like the mounts above.
  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "not found" });
  });

  // Production mode (#189, ADR-49): the built client and the API share one
  // port.
  if (options.clientDir) {
    const indexHtml = path.join(options.clientDir, "index.html");
    app.use(
      express.static(options.clientDir, {
        setHeaders: (res, filePath) => {
          // Vite content-hashes everything under assets/ — cache forever.
          // index.html is the mutable entry document: always revalidate, or
          // a deploy would strand browsers on a stale asset manifest.
          res.setHeader(
            "Cache-Control",
            filePath.includes(`${path.sep}assets${path.sep}`)
              ? "public, max-age=31536000, immutable"
              : "no-cache",
          );
        },
      }),
    );
    // SPA fallback: deep links (/stats, /goals) are client-side routes with
    // no file on disk — a refresh must get index.html, not a 404. Express 5
    // (path-to-regexp v8) dropped the bare "*" route, so this is a plain
    // middleware. GET/HEAD only: a stray POST to a client path is an error,
    // not a page view. Paths with an extension are missing FILES (a stale
    // hash after a redeploy): serving them index.html would hand the browser
    // text/html for a script tag — let them 404 instead.
    app.use((req, res, next) => {
      if (req.method !== "GET" && req.method !== "HEAD") return next();
      if (path.extname(req.path) !== "") return next();
      res.sendFile(indexHtml, { headers: { "Cache-Control": "no-cache" } });
    });
  }

  return app;
}
