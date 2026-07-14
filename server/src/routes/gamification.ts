import { Router } from "express";
import { gamificationState } from "../services/gamificationService.js";

export const gamificationRouter = Router();

gamificationRouter.get("/", (_req, res) => {
  res.json(gamificationState());
});
