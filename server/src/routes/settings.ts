import { Router } from "express";
import {
  API_KEY_SETTING,
  CURRENT_DRAW_SETTING,
  db,
  setSetting,
  WARMUP_DRAW_SETTING,
  WARMUP_LAST_DEALT_SETTING,
} from "../db.js";
import { REST_WEEKDAYS_SETTING } from "../services/gamificationService.js";

export const settingsRouter = Router();

// The stored Claude API key must never leak through the generic settings
// endpoints — it is managed exclusively via PUT/DELETE /api/ai/key. The
// current-draw pointer and the warm-up marker/rate-limit state (#57) are
// internal session state (GET /api/draw/current, GET /api/draw/warmup),
// not user settings.
function publicSettings(): Record<string, string> {
  const rows = db
    .prepare("SELECT key, value FROM settings WHERE key NOT IN (?, ?, ?, ?)")
    .all(
      API_KEY_SETTING,
      CURRENT_DRAW_SETTING,
      WARMUP_DRAW_SETTING,
      WARMUP_LAST_DEALT_SETTING,
    ) as { key: string; value: string }[];
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

/**
 * Validate + normalize streak_rest_weekdays (#58): a set of JS getDay
 * weekdays (0=Sun..6=Sat). All 7 is rejected — a streak needs at least one
 * required weekday, without which no day could ever be an uncoverable miss
 * and a run would be unbreakable. Returns the canonical stored value or an
 * error string.
 */
function normalizeRestWeekdays(value: unknown): { value?: string; error?: string } {
  if (!Array.isArray(value) || value.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
    return { error: "streak_rest_weekdays must be an array of weekday numbers 0 (Sun) to 6 (Sat)" };
  }
  const unique = [...new Set(value as number[])].sort((a, b) => a - b);
  if (unique.length === 7) {
    return { error: "at least one weekday must stay required — all 7 as rest days would leave nothing for the streak to count" };
  }
  return { value: JSON.stringify(unique) };
}

/**
 * Validate warmup_every_hours (#103). Zero is kept as an INTENTIONAL
 * off-switch rather than clamped away: "the warm-up is always available" is a
 * coherent thing to want — the escape hatch stays a deliberate deal of the
 * smallest card, never a re-roll (the route still refuses to deal while a
 * card stands, ADR-30c), so an unlimited allowance loosens the pacing, not
 * the commitment. What was actually broken is that ANY garbage got here: a
 * negative silently disabled the limit while reading like a limit, and a
 * non-numeric string fell back to the default 8 behind the user's back —
 * both of them settings that lie about what they do. Integers only, >= 0,
 * with 0 named.
 */
function warmupEveryHoursError(value: unknown): string | null {
  const parsed = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (!Number.isInteger(parsed) || (parsed as number) < 0) {
    return "warmup_every_hours must be a non-negative integer (hours) — 0 turns the rate limit off";
  }
  return null;
}

settingsRouter.get("/", (_req, res) => {
  res.json(publicSettings());
});

settingsRouter.patch("/", (req, res) => {
  const body = req.body ?? {};
  // Validate everything BEFORE writing anything — a rejected key must not
  // leave the other keys of the same request half-applied.
  let restWeekdays: string | undefined;
  if (REST_WEEKDAYS_SETTING in body) {
    const normalized = normalizeRestWeekdays(body[REST_WEEKDAYS_SETTING]);
    if (normalized.error) return res.status(400).json({ error: normalized.error });
    restWeekdays = normalized.value;
  }
  if ("warmup_every_hours" in body) {
    const error = warmupEveryHoursError(body.warmup_every_hours);
    if (error) return res.status(400).json({ error });
  }
  const allowed = [
    "max_draw_effort",
    "draw_cooldown_minutes",
    "daily_goal_completions",
    "warmup_every_hours",
  ];
  for (const key of allowed) {
    if (key in body) setSetting(key, String(body[key]));
  }
  if (restWeekdays !== undefined) setSetting(REST_WEEKDAYS_SETTING, restWeekdays);
  res.json(publicSettings());
});
