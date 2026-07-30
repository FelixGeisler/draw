import { Router } from "express";
import { notifyUnlocks } from "../services/notifyService.js";
import {
  claimAchievement,
  customizeAchievement,
  type AchievementPatch,
} from "../services/gamificationService.js";

export const achievementsRouter = Router();

// Display-only customization (#177, ADR-44): rename, rewrite the description, or
// hide an achievement. DISTINCT from POST /:key/claim below — this never
// touches unlock/claim/XP/rarity, only the metadata gamificationState()
// COALESCEs on. Partial: an absent field is left as-is; title/description = null
// clears that override (default restored), and a trimmed-empty string is
// normalized to null so blanking the editor input resets that field. Unknown
// key → 400 (validated in the service against ACHIEVEMENT_KEYS). Returns the
// updated achievement so a caller sees the COALESCE'd result without a re-GET.
achievementsRouter.patch("/:key", (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const patch: AchievementPatch = {};

  if ("title" in body) {
    const raw = body.title;
    if (raw !== null && typeof raw !== "string") {
      return res.status(400).json({ error: "title must be a string or null" });
    }
    const trimmed = typeof raw === "string" ? raw.trim() : null;
    patch.title = trimmed && trimmed.length > 0 ? trimmed : null;
  }
  if ("description" in body) {
    const raw = body.description;
    if (raw !== null && typeof raw !== "string") {
      return res.status(400).json({ error: "description must be a string or null" });
    }
    const trimmed = typeof raw === "string" ? raw.trim() : null;
    patch.description = trimmed && trimmed.length > 0 ? trimmed : null;
  }
  if ("hidden" in body) {
    if (typeof body.hidden !== "boolean") {
      return res.status(400).json({ error: "hidden must be a boolean" });
    }
    patch.hidden = body.hidden;
  }

  const result = customizeAchievement(req.params.key, patch);
  if (result.status === "unknown") {
    return res.status(400).json({ error: "unknown achievement" });
  }
  return res.json(result.achievement);
});

// Claim-for-XP (#156, ADR-42): an unlocked achievement pays rarity-scaled XP
// once ever. 200 with the payout, 400 for an unknown or not-yet-unlocked key,
// 409 for a repeat — the guard is idempotent, so a double-click is safe.
achievementsRouter.post("/:key/claim", (req, res) => {
  const result = claimAchievement(req.params.key);
  switch (result.status) {
    case "ok":
      notifyUnlocks(result.newAchievements); // post-commit (#235)
      return res.json({
        xpAwarded: result.xpAwarded,
        levelUp: result.levelUp,
        // A claim that crosses a level threshold unlocks the level_N card in
        // the same transaction (#156 review) — relay it like any unlock.
        newAchievements: result.newAchievements,
      });
    case "unknown":
      return res.status(400).json({ error: "unknown achievement" });
    case "locked":
      return res.status(400).json({ error: "achievement not unlocked yet" });
    case "claimed":
      return res.status(409).json({ error: "achievement already claimed" });
  }
});
