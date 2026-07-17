import { Router } from "express";
import { z } from "zod";
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
import { agentEstimate, applyOperations, runAgentTurn } from "../services/agentService.js";
import { applyBodySchema } from "../services/agentStaging.js";
import { invalidateAllFileIds } from "../services/materialFiles.js";
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
  // Cached Anthropic file ids (#92) belong to whatever account the OLD key
  // pointed at; under a new key they are useless at best. Drop them so the
  // next AI call re-uploads under the current key, instead of leaning on the
  // lazy 404 path to notice one material at a time.
  invalidateAllFileIds();
  res.json(status());
});

aiRouter.delete("/key", (_req, res) => {
  deleteSetting(API_KEY_SETTING);
  // Same reasoning as PUT: the removed key's file ids can never be valid
  // again (a re-added key is a fresh upload target), so don't keep them.
  invalidateAllFileIds();
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

// ---------------------------------------------------------------------------
// Conversational assistant (#31, ADR-37). One shared shape gate: the message
// endpoints take { sessionId?, goalId?, materialIds?, message }; malformed
// requests 400 before the isConfigured check, like every AI route (#84).

function agentShapeError(body: Record<string, unknown>): string | null {
  if (typeof body.message !== "string" || !body.message.trim()) {
    return "message is required";
  }
  if (body.sessionId != null && typeof body.sessionId !== "string") {
    return "sessionId must be a string";
  }
  return (
    (body.goalId != null ? idShapeError(body.goalId, "goalId") : null) ??
    materialIdsShapeError(body.materialIds)
  );
}

aiRouter.post("/agent/message", async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const shapeError = agentShapeError(body);
  if (shapeError) return res.status(400).json({ error: shapeError });
  if (!isConfigured()) return res.status(503).json({ error: "ai_not_configured" });
  try {
    res.json(
      await runAgentTurn({
        sessionId: body.sessionId as string | undefined,
        goalId: body.goalId as number | undefined,
        materialIds: body.materialIds as number[] | undefined,
        message: (body.message as string).trim(),
      }),
    );
  } catch (e) {
    handle(res, e);
  }
});

// Prices the FIRST send (system + tools + materials + message) before it
// runs — the estimate-gate pattern of the other panels, minus their
// taskId/goalId requirement (a plain chat needs no goal). Input-only by
// nature; the per-turn usage line reports the actual cost including output.
aiRouter.post("/agent/estimate", async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const shapeError = agentShapeError(body);
  if (shapeError) return res.status(400).json({ error: shapeError });
  if (!isConfigured()) return res.status(503).json({ error: "ai_not_configured" });
  try {
    res.json(
      await agentEstimate({
        goalId: body.goalId as number | undefined,
        materialIds: body.materialIds as number[] | undefined,
        message: (body.message as string).trim(),
      }),
    );
  } catch (e) {
    handle(res, e);
  }
});

// Applies the REVIEWED operations (the checkbox review is the sole write
// path, ADR-14: included rows and the user's title/effort edits travel in
// the body) in one transaction — any rejected row rolls back everything.
// 503-gated like its siblings even though it never calls the SDK: the whole
// assistant surface is hidden in degraded mode.
aiRouter.post("/agent/apply", (req, res) => {
  const parsed = applyBodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: `invalid operations: ${z.prettifyError(parsed.error)}` });
  }
  if (!isConfigured()) return res.status(503).json({ error: "ai_not_configured" });
  try {
    res.status(201).json(applyOperations(parsed.data.operations, parsed.data.sessionId));
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
