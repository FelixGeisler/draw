import { Router } from "express";
import { AiError, breakdown, estimate, isConfigured, MODEL, planGoal, resolveApiKey } from "../services/aiService.js";
import { API_KEY_SETTING, deleteSetting, setSetting } from "../db.js";

export const aiRouter = Router();

function handle(res: { status: (n: number) => { json: (b: unknown) => void } }, e: unknown) {
  if (e instanceof AiError) return res.status(e.status).json({ error: e.message });
  res.status(500).json({ error: e instanceof Error ? e.message : "unknown error" });
}

// Reports configuration state only — the key itself is never returned by any endpoint.
function status() {
  const resolved = resolveApiKey();
  return { configured: resolved !== null, model: MODEL, keySource: resolved?.source ?? null };
}

aiRouter.get("/status", (_req, res) => {
  res.json(status());
});

// The key is written/removed only through these dedicated endpoints;
// GET/PATCH /api/settings never sees it.
aiRouter.put("/key", (req, res) => {
  const key = typeof req.body?.key === "string" ? req.body.key.trim() : "";
  if (!key) return res.status(400).json({ error: "key is required" });
  setSetting(API_KEY_SETTING, key);
  res.json(status());
});

aiRouter.delete("/key", (_req, res) => {
  deleteSetting(API_KEY_SETTING);
  res.json(status());
});

aiRouter.post("/estimate", async (req, res) => {
  if (!isConfigured()) return res.status(503).json({ error: "ai_not_configured" });
  try {
    const { taskId, goalId, materialIds } = req.body ?? {};
    res.json(await estimate({ taskId, goalId, materialIds }));
  } catch (e) {
    handle(res, e);
  }
});

aiRouter.post("/breakdown", async (req, res) => {
  if (!isConfigured()) return res.status(503).json({ error: "ai_not_configured" });
  try {
    const { taskId, materialIds } = req.body ?? {};
    if (!taskId) return res.status(400).json({ error: "taskId is required" });
    res.json(await breakdown(Number(taskId), materialIds ?? []));
  } catch (e) {
    handle(res, e);
  }
});

aiRouter.post("/plan-goal", async (req, res) => {
  if (!isConfigured()) return res.status(503).json({ error: "ai_not_configured" });
  try {
    const { goalId, materialIds, userNotes } = req.body ?? {};
    if (!goalId) return res.status(400).json({ error: "goalId is required" });
    res.json(await planGoal(Number(goalId), materialIds ?? [], userNotes));
  } catch (e) {
    handle(res, e);
  }
});
