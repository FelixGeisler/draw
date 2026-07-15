import { Router } from "express";
import {
  currentDraw,
  drawPool,
  drawTask,
  warmupAvailability,
  warmupDraw,
} from "../services/drawService.js";
import { checkAchievements } from "../services/gamificationService.js";

export const drawRouter = Router();

// Side-effect-free deck snapshot (issue #36, backs the MCP draw://deck
// resource): the same candidate query and weights as POST /api/draw, but no
// last_drawn_at stamp, no persisted current draw, no achievement check.
drawRouter.get("/pool", (req, res) => {
  res.json(
    drawPool({
      categoryId: req.query.categoryId ? Number(req.query.categoryId) : undefined,
      goalId: req.query.goalId ? Number(req.query.goalId) : undefined,
    }),
  );
});

drawRouter.post("/", (req, res) => {
  const { categoryId, goalId } = req.body ?? {};
  const result = drawTask({
    categoryId: categoryId ? Number(categoryId) : undefined,
    goalId: goalId ? Number(goalId) : undefined,
  });
  const newAchievements = result.task ? checkAchievements({ drew: true }) : [];
  res.json({ ...result, newAchievements });
});

// Warm-up draw (#57, ADR-30): deterministically deal the smallest eligible
// card. Same response shape as POST /api/draw minus `probability` (there is
// none — nothing was gambled), plus the `warmup` marker on success and
// `nextWarmupAt` when rate-limited.
drawRouter.post("/warmup", (req, res) => {
  // The #88 hard line, extended to the warm-up: a deal is not a re-roll. A
  // valid current draw (lazy-validated exactly like GET /current — a stale
  // pointer clears itself and does not block) must be resolved first.
  if (currentDraw() != null) {
    return res.status(409).json({
      error:
        "a drawn card is still active — complete, snooze, or delete it first; " +
        "the warm-up never replaces a draw",
    });
  }
  const { categoryId, goalId } = req.body ?? {};
  const result = warmupDraw({
    categoryId: categoryId ? Number(categoryId) : undefined,
    goalId: goalId ? Number(goalId) : undefined,
  });
  const newAchievements = result.task ? checkAchievements({ drew: true }) : [];
  res.json({ ...result, newAchievements });
});

// Availability probe for the idle page's warm-up button — disabled with a
// countdown hint while the one-per-`warmup_every_hours` allowance is spent.
drawRouter.get("/warmup", (_req, res) => {
  res.json(warmupAvailability(new Date()));
});

// Restore endpoint (ADR-13): null when there is no valid current draw —
// mirrors GET /api/timer/current. Carries the warm-up marker (#57) when the
// restored card was warm-up dealt, so the badge survives a reload.
drawRouter.get("/current", (_req, res) => {
  res.json(currentDraw());
});
