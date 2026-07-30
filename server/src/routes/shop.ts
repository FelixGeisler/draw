import { Router } from "express";
import { db } from "../db.js";
import { streakState, totalXp } from "../services/gamificationService.js";
import { FREEZE_BANK_CAP } from "../services/streak.js";
import {
  buyFreeze,
  buyPack,
  CARD_BACKS,
  equipBack,
  equippedBack,
  FREEZE_COST,
  ownedBacks,
  PACK_COST,
  ShopError,
} from "../services/shopService.js";

export const shopRouter = Router();

// The XP shop (#230, ADR-62). GET is side-effect free; both writes run in a
// transaction so a charge and its effects exist together or not at all, and
// carry a client-supplied `ref` the ledger's UNIQUE(reason, ref) turns into
// double-click safety (409 on replay).

function snapshot() {
  const owned = new Set(ownedBacks());
  return {
    xp: totalXp(),
    packCost: PACK_COST,
    freezeCost: FREEZE_COST,
    freezesBanked: streakState().freezesBanked,
    freezeBankCap: FREEZE_BANK_CAP,
    backs: CARD_BACKS.map((b) => ({ ...b, owned: owned.has(b.key) })),
    equipped: equippedBack(),
  };
}

shopRouter.get("/", (_req, res) => {
  res.json(snapshot());
});

shopRouter.post("/buy", (req, res) => {
  const { item, ref } = (req.body ?? {}) as { item?: unknown; ref?: unknown };
  if (typeof ref !== "string" || !ref.trim()) {
    return res.status(400).json({ error: "ref is required — it is what makes a retry harmless" });
  }
  try {
    if (item === "pack") {
      const result = db.transaction(() => buyPack(totalXp, ref))();
      return res.json({ ...result, ...snapshot() });
    }
    if (item === "freeze") {
      db.transaction(() => buyFreeze(totalXp, () => streakState().freezesBanked, FREEZE_BANK_CAP, ref))();
      return res.json(snapshot());
    }
    return res.status(400).json({ error: "item must be 'pack' or 'freeze'" });
  } catch (e) {
    if (e instanceof ShopError) return res.status(e.status).json({ error: e.message });
    throw e;
  }
});

shopRouter.post("/equip", (req, res) => {
  const { back } = (req.body ?? {}) as { back?: unknown };
  if (typeof back !== "string") return res.status(400).json({ error: "back is required" });
  try {
    equipBack(back);
  } catch (e) {
    if (e instanceof ShopError) return res.status(e.status).json({ error: e.message });
    throw e;
  }
  res.json(snapshot());
});
