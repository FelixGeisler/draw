import { Router } from "express";
import { drawTask } from "../services/drawService.js";
import { checkAchievements } from "../services/gamificationService.js";

export const drawRouter = Router();

drawRouter.post("/", (req, res) => {
  const { categoryId, goalId } = req.body ?? {};
  const result = drawTask({
    categoryId: categoryId ? Number(categoryId) : undefined,
    goalId: goalId ? Number(goalId) : undefined,
  });
  const newAchievements = result.task ? checkAchievements({ drew: true }) : [];
  res.json({ ...result, newAchievements });
});
