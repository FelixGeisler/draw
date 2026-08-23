import { Router } from "express";
import {
  buyPack,
  equipBack,
  shopSnapshot,
  ShopError,
  type PackPayment,
} from "../services/shopService.js";

const ALLOWED_BUY_KEYS = new Set(["item", "payment", "ref"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

/** Shop HTTP composition seam: production supplies Math.random from createApp. */
export function createShopRouter(random: () => number): Router {
  const router = Router();

  router.get("/", (_req, res) => {
    res.json(shopSnapshot());
  });

  router.post("/buy", (req, res) => {
    const body: unknown = req.body;
    if (!isPlainObject(body) || Object.keys(body).some((key) => !ALLOWED_BUY_KEYS.has(key))) {
      return res.status(400).json({ error: "body must contain only item, payment, and ref" });
    }
    if (body.item !== "pack") {
      return res.status(400).json({ error: "item must be 'pack'" });
    }
    if (body.payment !== "gold" && body.payment !== "ticket") {
      return res.status(400).json({ error: "payment must be 'gold' or 'ticket'" });
    }
    if (typeof body.ref !== "string" || body.ref.trim() === "") {
      return res.status(400).json({ error: "ref must be a non-blank string" });
    }

    try {
      return res.json(buyPack(body.payment as PackPayment, body.ref.trim(), random));
    } catch (error) {
      if (error instanceof ShopError) {
        return res.status(error.status).json({ error: error.message });
      }
      throw error;
    }
  });

  router.post("/equip", (req, res) => {
    const { back } = (req.body ?? {}) as { back?: unknown };
    if (typeof back !== "string") return res.status(400).json({ error: "back is required" });
    try {
      equipBack(back);
    } catch (error) {
      if (error instanceof ShopError) return res.status(error.status).json({ error: error.message });
      throw error;
    }
    res.json(shopSnapshot());
  });

  return router;
}
