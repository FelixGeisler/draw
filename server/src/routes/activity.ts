import { Router } from "express";
import { addDays, computeActivity } from "../services/activityService.js";

export const activityRouter = Router();

/** Valid YYYY-MM-DD that round-trips (rejects 2026-02-30 and friends). */
function isValidDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** Today as a LOCAL date — the skyline buckets by local day, unlike stats. */
function localToday(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Default fetch window: the last 8 weeks — the client extends via `from`. */
const DEFAULT_WINDOW_DAYS = 56;

// GET /api/activity?from=YYYY-MM-DD&to=YYYY-MM-DD — local dates, inclusive.
activityRouter.get("/", (req, res) => {
  const to = (req.query.to as string | undefined) ?? localToday();
  if (!isValidDate(to)) {
    return res.status(400).json({ error: "to must be a valid YYYY-MM-DD date" });
  }
  const from = (req.query.from as string | undefined) ?? addDays(to, -(DEFAULT_WINDOW_DAYS - 1));
  if (!isValidDate(from)) {
    return res.status(400).json({ error: "from must be a valid YYYY-MM-DD date" });
  }
  if (from > to) {
    return res.status(400).json({ error: "from must not be after to" });
  }
  res.json({ days: computeActivity(from, to) });
});
