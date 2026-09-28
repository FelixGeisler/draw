import { Router } from "express";
import {
  WeekRequestError,
  parseWeekRequestQuery,
  projectWeek,
} from "../services/weekProjection.js";

export const calendarRouter = Router();

calendarRouter.get("/week", (req, res) => {
  // The projection is authenticated by app.ts's existing ADR-50 gate. It is
  // read-only and must not become a browser or intermediary persistence seam.
  res.set("Cache-Control", "no-store");
  try {
    const input = parseWeekRequestQuery(req.query as Record<string, unknown>);
    return res.json(projectWeek(input));
  } catch (error) {
    if (error instanceof WeekRequestError) {
      return res.status(400).json({ error: "invalid-week-request" });
    }
    return res.status(500).json({ error: "week-projection-failed" });
  }
});
