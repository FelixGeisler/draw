import express from "express";
import { tasksRouter } from "./routes/tasks.js";
import { categoriesRouter } from "./routes/categories.js";
import { settingsRouter } from "./routes/settings.js";
import { drawRouter } from "./routes/draw.js";
import { timerRouter } from "./routes/timer.js";
import { statsRouter } from "./routes/stats.js";
import { activityRouter } from "./routes/activity.js";
import { gamificationRouter } from "./routes/gamification.js";
import { goalsRouter } from "./routes/goals.js";
import { goalMaterialsRouter, materialsRouter } from "./routes/materials.js";
import { aiRouter } from "./routes/ai.js";
import { backupRouter } from "./routes/backup.js";

export function createApp() {
  const app = express();
  app.use(express.json());

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, time: new Date().toISOString() });
  });

  app.use("/api/tasks", tasksRouter);
  app.use("/api/categories", categoriesRouter);
  app.use("/api/settings", settingsRouter);
  app.use("/api/draw", drawRouter);
  app.use("/api/timer", timerRouter);
  app.use("/api/stats", statsRouter);
  app.use("/api/activity", activityRouter);
  app.use("/api/gamification", gamificationRouter);
  app.use("/api/goals", goalsRouter);
  app.use("/api/goals/:id/materials", goalMaterialsRouter);
  app.use("/api/materials", materialsRouter);
  app.use("/api/ai", aiRouter);
  app.use("/api/backup", backupRouter);

  return app;
}
