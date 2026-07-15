import { Router } from "express";
import {
  AiError,
  breakdown,
  estimate,
  generateTasks,
  isConfigured,
  MODEL,
  planGoal,
  resolveApiKey,
} from "../services/aiService.js";
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

// ---------------------------------------------------------------------------
// Request-shape validation (#84). Malformed requests are 400 regardless of
// key state, so these run BEFORE every isConfigured check (and stay testable
// in degraded mode) — generate-tasks set the precedent, now uniform across
// the AI routes. Ids are strict positive integers: the previous
// Number(goalId) coercion let `goalId: true` quietly become goal 1, and an
// unchecked materialIds reached materialBlocks as `.map is not a function` —
// a raw 500.

function idShapeError(value: unknown, name: string): string | null {
  return Number.isInteger(value) && (value as number) >= 1
    ? null
    : `${name} must be a positive integer`;
}

function materialIdsShapeError(value: unknown): string | null {
  if (value == null) return null;
  if (!Array.isArray(value) || value.some((id) => !Number.isInteger(id) || id < 1)) {
    return "materialIds must be an array of positive integer material ids";
  }
  return null;
}

function stringShapeError(value: unknown, name: string): string | null {
  return value == null || typeof value === "string" ? null : `${name} must be a string`;
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
  const { taskId, goalId, materialIds, instruction } = req.body ?? {};
  if (taskId == null && goalId == null) {
    return res.status(400).json({ error: "taskId or goalId required" });
  }
  const shapeError =
    (taskId != null ? idShapeError(taskId, "taskId") : null) ??
    (goalId != null ? idShapeError(goalId, "goalId") : null) ??
    materialIdsShapeError(materialIds) ??
    stringShapeError(instruction, "instruction");
  if (shapeError) return res.status(400).json({ error: shapeError });
  if (!isConfigured()) return res.status(503).json({ error: "ai_not_configured" });
  try {
    res.json(await estimate({ taskId, goalId, materialIds, instruction }));
  } catch (e) {
    handle(res, e);
  }
});

aiRouter.post("/breakdown", async (req, res) => {
  const { taskId, materialIds } = req.body ?? {};
  if (taskId == null) return res.status(400).json({ error: "taskId is required" });
  const shapeError = idShapeError(taskId, "taskId") ?? materialIdsShapeError(materialIds);
  if (shapeError) return res.status(400).json({ error: shapeError });
  if (!isConfigured()) return res.status(503).json({ error: "ai_not_configured" });
  try {
    res.json(await breakdown(taskId, materialIds ?? []));
  } catch (e) {
    handle(res, e);
  }
});

aiRouter.post("/plan-goal", async (req, res) => {
  const { goalId, materialIds, userNotes } = req.body ?? {};
  if (goalId == null) return res.status(400).json({ error: "goalId is required" });
  const shapeError =
    idShapeError(goalId, "goalId") ??
    materialIdsShapeError(materialIds) ??
    stringShapeError(userNotes, "userNotes");
  if (shapeError) return res.status(400).json({ error: shapeError });
  if (!isConfigured()) return res.status(503).json({ error: "ai_not_configured" });
  try {
    res.json(await planGoal(goalId, materialIds ?? [], userNotes));
  } catch (e) {
    handle(res, e);
  }
});

aiRouter.post("/generate-tasks", async (req, res) => {
  const { goalId, materialIds, instruction } = req.body ?? {};
  if (goalId == null) return res.status(400).json({ error: "goalId is required" });
  if (typeof instruction !== "string" || !instruction.trim()) {
    return res.status(400).json({ error: "instruction is required" });
  }
  const shapeError = idShapeError(goalId, "goalId") ?? materialIdsShapeError(materialIds);
  if (shapeError) return res.status(400).json({ error: shapeError });
  if (!isConfigured()) return res.status(503).json({ error: "ai_not_configured" });
  try {
    res.json(await generateTasks(goalId, materialIds ?? [], instruction.trim()));
  } catch (e) {
    handle(res, e);
  }
});
