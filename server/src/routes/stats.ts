import { Router } from "express";
import { computeEstimationBias, computeStats } from "../services/statsService.js";

export const statsRouter = Router();

/** Date-only arithmetic in UTC — avoids local-timezone off-by-one-day shifts. */
function addDays(dateStr: string, n: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

statsRouter.get("/", (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const from = (req.query.from as string) || addDays(today, -6);
  const toInclusive = (req.query.to as string) || today;
  res.json(computeStats(from, addDays(toInclusive, 1)));
});

// All-history per-category estimation bias (#55) — deliberately unranged:
// coaching reads a habit, not a week. Display thresholds live in the client.
statsRouter.get("/estimation-bias", (_req, res) => {
  res.json(computeEstimationBias());
});
