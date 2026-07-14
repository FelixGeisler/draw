import { Router } from "express";
import { db, setSetting } from "../db.js";

export const settingsRouter = Router();

settingsRouter.get("/", (_req, res) => {
  const rows = db.prepare("SELECT key, value FROM settings").all() as {
    key: string;
    value: string;
  }[];
  res.json(Object.fromEntries(rows.map((r) => [r.key, r.value])));
});

settingsRouter.patch("/", (req, res) => {
  const body = req.body ?? {};
  const allowed = ["max_draw_effort", "draw_cooldown_minutes", "daily_goal_completions"];
  for (const key of allowed) {
    if (key in body) setSetting(key, String(body[key]));
  }
  const rows = db.prepare("SELECT key, value FROM settings").all() as {
    key: string;
    value: string;
  }[];
  res.json(Object.fromEntries(rows.map((r) => [r.key, r.value])));
});
