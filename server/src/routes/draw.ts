import { Router } from "express";
import { currentDraw, drawPool, drawTask } from "../services/drawService.js";
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

// Restore endpoint (ADR-13): null when there is no valid current draw —
// mirrors GET /api/timer/current.
drawRouter.get("/current", (_req, res) => {
  res.json(currentDraw());
});
