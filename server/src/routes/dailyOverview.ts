import { Router } from "express";
import { dailyOverviewForDate } from "../services/dailyOverviewService.js";
import { validTimeZone, zonedLocalDate } from "../services/localDay.js";

export const dailyOverviewRouter = Router();

dailyOverviewRouter.get("/", (req, res) => {
  const timezone = req.query.timezone;
  if (!validTimeZone(timezone)) {
    return res.status(400).json({ error: "invalid timezone" });
  }
  const localDate = zonedLocalDate(timezone, new Date());
  const groups = dailyOverviewForDate(localDate);
  res.json({
    timezone,
    localDate,
    counts: {
      overdue: groups.overdue.length,
      today: groups.today.length,
      tomorrow: groups.tomorrow.length,
    },
    groups,
  });
});
