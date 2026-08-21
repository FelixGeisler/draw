import { Router } from "express";
import { streakState, totalGold } from "../services/gamificationService.js";
import { FREEZE_BANK_CAP } from "../services/streak.js";
import {
  CARD_BACKS,
  equipBack,
  equippedBack,
  ownedBacks,
  ShopError,
} from "../services/shopService.js";

export const shopRouter = Router();

/** Exact transitional collection payload (#263); GET remains side-effect free. */
function snapshot() {
  const owned = new Set(ownedBacks());
  return {
    gold: totalGold(),
    freezesBanked: streakState().freezesBanked,
    freezeBankCap: FREEZE_BANK_CAP,
    backs: CARD_BACKS.map((back) => ({ ...back, owned: owned.has(back.key) })),
    equipped: equippedBack(),
  };
}

shopRouter.get("/", (_req, res) => {
  res.json(snapshot());
});

// Until #266 every request which reaches this route has one exact response.
// Authentication, express.json parsing and the global body limit retain their
// existing precedence; this handler performs no transaction, RNG or write.
shopRouter.post("/buy", (_req, res) => {
  res.status(400).json({ error: "shop purchases are unavailable" });
});

shopRouter.post("/equip", (req, res) => {
  const { back } = (req.body ?? {}) as { back?: unknown };
  if (typeof back !== "string") return res.status(400).json({ error: "back is required" });
  try {
    equipBack(back);
  } catch (error) {
    if (error instanceof ShopError) return res.status(error.status).json({ error: error.message });
    throw error;
  }
  res.json(snapshot());
});
