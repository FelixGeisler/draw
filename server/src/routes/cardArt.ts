import { Router } from "express";
import { getCachedCardArt } from "../services/cardArtService.js";

export const cardArtRouter = Router();

/**
 * GET /api/card-art?taskIds=1,2,3 — cache-only batch art read (#114, #115).
 *
 * Backs the trophy pile's mini-frames: one round trip for the whole pile
 * instead of N per-card GETs, and — the hard constraint — NEVER a generation:
 * GET /api/tasks/:id/card-art generates on a cache miss, so the pile cannot
 * call it blindly for N cards. This endpoint reads the card_art cache and
 * nothing else; completions whose art was never generated are simply absent
 * from the response and keep the client-side gradient.
 *
 * taskIds is a comma-separated list of positive integers (the #84 convention:
 * malformed shapes answer an honest 400, never a driver-level 500). Unknown
 * ids yield no row; duplicates are deduped server-side.
 */
cardArtRouter.get("/", (req, res) => {
  const raw = req.query.taskIds;
  if (typeof raw !== "string" || raw.trim() === "") {
    return res
      .status(400)
      .json({ error: "taskIds is required — a comma-separated list of task ids" });
  }
  const ids: number[] = [];
  for (const part of raw.split(",")) {
    const n = Number(part.trim());
    if (!Number.isInteger(n) || n < 1) {
      return res
        .status(400)
        .json({ error: "taskIds must be a comma-separated list of positive integers" });
    }
    ids.push(n);
  }
  res.json({ arts: getCachedCardArt(ids) });
});
