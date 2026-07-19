import { Router } from "express";
import { claimAchievement } from "../services/gamificationService.js";

export const achievementsRouter = Router();

// Claim-for-XP (#156, ADR-42): an unlocked achievement pays rarity-scaled XP
// once ever. 200 with the payout, 400 for an unknown or not-yet-unlocked key,
// 409 for a repeat — the guard is idempotent, so a double-click is safe.
achievementsRouter.post("/:key/claim", (req, res) => {
  const result = claimAchievement(req.params.key);
  switch (result.status) {
    case "ok":
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
