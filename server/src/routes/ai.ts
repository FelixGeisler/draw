import { Router } from "express";
import { AiError, breakdown, configured, estimate, MODEL, planGoal } from "../services/aiService.js";

export const aiRouter = Router();

function handle(res: { status: (n: number) => { json: (b: unknown) => void } }, e: unknown) {
  if (e instanceof AiError) return res.status(e.status).json({ error: e.message });
  res.status(500).json({ error: e instanceof Error ? e.message : "unknown error" });
}

aiRouter.get("/status", (_req, res) => {
  res.json({ configured, model: MODEL });
});

aiRouter.post("/estimate", async (req, res) => {
  if (!configured) return res.status(503).json({ error: "ai_not_configured" });
  try {
    const { taskId, goalId, materialIds } = req.body ?? {};
    res.json(await estimate({ taskId, goalId, materialIds }));
  } catch (e) {
    handle(res, e);
  }
});

aiRouter.post("/breakdown", async (req, res) => {
  if (!configured) return res.status(503).json({ error: "ai_not_configured" });
  try {
    const { taskId, materialIds } = req.body ?? {};
    if (!taskId) return res.status(400).json({ error: "taskId is required" });
    res.json(await breakdown(Number(taskId), materialIds ?? []));
  } catch (e) {
    handle(res, e);
  }
});

aiRouter.post("/plan-goal", async (req, res) => {
  if (!configured) return res.status(503).json({ error: "ai_not_configured" });
  try {
    const { goalId, materialIds, userNotes } = req.body ?? {};
    if (!goalId) return res.status(400).json({ error: "goalId is required" });
    res.json(await planGoal(Number(goalId), materialIds ?? [], userNotes));
  } catch (e) {
    handle(res, e);
  }
});
