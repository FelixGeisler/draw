import { Router } from "express";
import { API_KEY_SETTING, db, setSetting } from "../db.js";

export const settingsRouter = Router();

// The stored Claude API key must never leak through the generic settings
// endpoints — it is managed exclusively via PUT/DELETE /api/ai/key.
function publicSettings(): Record<string, string> {
  const rows = db
    .prepare("SELECT key, value FROM settings WHERE key != ?")
    .all(API_KEY_SETTING) as { key: string; value: string }[];
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

settingsRouter.get("/", (_req, res) => {
  res.json(publicSettings());
});

settingsRouter.patch("/", (req, res) => {
  const body = req.body ?? {};
  const allowed = ["max_draw_effort", "draw_cooldown_minutes", "daily_goal_completions"];
  for (const key of allowed) {
    if (key in body) setSetting(key, String(body[key]));
  }
  res.json(publicSettings());
});
