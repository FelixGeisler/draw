import express from "express";
import { tasksRouter } from "./routes/tasks.js";
import { categoriesRouter } from "./routes/categories.js";
import { settingsRouter } from "./routes/settings.js";
import { drawRouter } from "./routes/draw.js";
import { handRouter } from "./routes/hand.js";
import { timerRouter } from "./routes/timer.js";
import { statsRouter } from "./routes/stats.js";
import { activityRouter } from "./routes/activity.js";
import { gamificationRouter } from "./routes/gamification.js";
import { goalsRouter } from "./routes/goals.js";
import { goalMaterialsRouter, materialsRouter } from "./routes/materials.js";
import { aiRouter } from "./routes/ai.js";
import { backupRouter } from "./routes/backup.js";
import { cardArtRouter } from "./routes/cardArt.js";
import { sweepBackupTemp } from "./services/backupService.js";
import { bindAgentToolApi } from "./services/agentService.js";
import { InProcessApiClient } from "./tools/inProcessApi.js";

export function createApp() {
  const app = express();
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

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, time: new Date().toISOString() });
  });

  app.use("/api/tasks", tasksRouter);
  app.use("/api/categories", categoriesRouter);
  app.use("/api/settings", settingsRouter);
  app.use("/api/draw", drawRouter);
  // The daily hand (#59) — its own resource, not a sub-route of /api/draw:
  // dealing is not drawing (no last_drawn_at, no achievement), and only
  // POST /api/hand/play crosses over into the current draw.
  app.use("/api/hand", handRouter);
  app.use("/api/timer", timerRouter);
  app.use("/api/stats", statsRouter);
  app.use("/api/activity", activityRouter);
  app.use("/api/gamification", gamificationRouter);
  app.use("/api/goals", goalsRouter);
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
  // ADR-19 argument), with or without a public listener (supertest).
  bindAgentToolApi(new InProcessApiClient(app));

  return app;
}
