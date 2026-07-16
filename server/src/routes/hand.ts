import { Router } from "express";
import { currentDraw } from "../services/drawService.js";
import { currentHand, dealHand, playHandCard } from "../services/handService.js";
import { checkAchievements } from "../services/gamificationService.js";

export const handRouter = Router();

// Daily hand (#59, ADR-34) — "deal me a day". Deliberately NO redeal endpoint:
// re-dealing five cards is the card-fishing #88 removed from the single draw
// (see ADR-34 for why "one free redeal" was rejected). A hand shrinks by
// resolving its cards, and the freestyle draw below the strip is always there.

/** Today's hand, or null — mirrors GET /api/draw/current. Lazily validated:
 *  members that went stale sideways are pruned permanently (ADR-13). */
handRouter.get("/", (_req, res) => {
  res.json(currentHand());
});

// One hand per local day: a second deal is a 409, not a silent replacement.
handRouter.post("/deal", (_req, res) => {
  if (currentHand() != null) {
    return res.status(409).json({
      error:
        "today's hand is already dealt — play its cards, or resolve the ones you do not want; " +
        "a fresh hand comes with tomorrow",
    });
  }
  res.json(dealHand());
});

// Play a card: it becomes the current draw (ADR-13) with a real draw's side
// effects, so the reveal, the reload-restore and the drawn bonus are the
// existing ones.
handRouter.post("/play", (req, res) => {
  const taskId = Number(req.body?.taskId);
  if (!Number.isInteger(taskId) || taskId < 1) {
    return res.status(400).json({ error: "taskId must be a positive integer" });
  }
  // The #88 hard line, the same one the warm-up deal draws: a valid current
  // draw (lazy-validated exactly like GET /api/draw/current — a stale pointer
  // clears itself and does not block) must be resolved before another card
  // can be played. Without this the hand would be a five-card re-roll rack.
  if (currentDraw() != null) {
    return res.status(409).json({
      error:
        "a card is still in play — complete, snooze, or delete it first; " +
        "playing a hand card never replaces the card on the table",
    });
  }

  const result = playHandCard(taskId);
  if (result === "no_hand") {
    return res.status(404).json({ error: "no hand dealt for today" });
  }
  if (result === "not_in_hand") {
    return res.status(404).json({ error: "that card is not in today's hand" });
  }
  // Playing IS drawing (dealing was not) — so this is where the draw
  // achievements fire, exactly as in POST /api/draw.
  res.json({ ...result, newAchievements: checkAchievements({ drew: true }) });
});
