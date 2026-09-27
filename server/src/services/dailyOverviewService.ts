import type Database from "better-sqlite3";
import { db } from "../db.js";
import { addCalendarDays, validCalendarDate } from "./localDay.js";

export type DailyOverviewItemType = "goal" | "task";
export type DailyOverviewGroup = "overdue" | "today" | "tomorrow";

export interface DailyOverviewItem {
  type: DailyOverviewItemType;
  id: number;
  title: string;
  date: string;
}

export interface DailyOverviewGroups {
  overdue: DailyOverviewItem[];
  today: DailyOverviewItem[];
  tomorrow: DailyOverviewItem[];
}

export interface DailyDigestProjection {
  overdueCount: number;
  todayCount: number;
  tomorrowCount: number;
  titles: string[];
}

// Both public projections are built from this one eligible relation. Date
// validation is deliberately in SQL so malformed legacy rows cannot enter
// either the aggregate or the bounded title read.
export const DAILY_OVERVIEW_ELIGIBLE_SQL = `
  eligible(type,id,title,date,created_at) AS MATERIALIZED (
    SELECT 'task', id, title, due_date, created_at
    FROM tasks
    WHERE status = 'open' AND due_date IS NOT NULL
      AND length(due_date)=10
      AND due_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
      AND substr(due_date,1,4) <> '0000'
      AND strftime('%Y-%m-%d', due_date) = due_date
    UNION ALL
    SELECT 'goal', id, title, target_date, created_at
    FROM goals
    WHERE status = 'active' AND target_date IS NOT NULL
      AND length(target_date)=10
      AND target_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
      AND substr(target_date,1,4) <> '0000'
      AND strftime('%Y-%m-%d', target_date) = target_date
  )`;

export const DAILY_DIGEST_COUNTS_SQL = `WITH ${DAILY_OVERVIEW_ELIGIBLE_SQL}
  SELECT
    COALESCE(SUM(CASE WHEN date < ? THEN 1 ELSE 0 END),0) AS overdueCount,
    COALESCE(SUM(CASE WHEN date = ? THEN 1 ELSE 0 END),0) AS todayCount,
    COALESCE(SUM(CASE WHEN date = ? THEN 1 ELSE 0 END),0) AS tomorrowCount
  FROM eligible
  WHERE date <= ?`;

export const DAILY_DIGEST_TITLES_SQL = `WITH ${DAILY_OVERVIEW_ELIGIBLE_SQL}
  SELECT title
  FROM eligible
  WHERE date <= ?
  ORDER BY CASE WHEN date < ? THEN 0 WHEN date = ? THEN 1 ELSE 2 END,
           date ASC, type ASC, id ASC, created_at ASC
  LIMIT 5`;

/** Read complete `/today` rows for an explicit local date. */
export function dailyOverviewForDate(
  localDate: string,
  database: Database.Database = db,
): DailyOverviewGroups {
  if (!validCalendarDate(localDate)) throw new Error("invalid local date");
  const tomorrowDate = addCalendarDays(localDate, 1);
  const groups: DailyOverviewGroups = { overdue: [], today: [], tomorrow: [] };
  const upper = tomorrowDate ?? localDate;
  const rows = database.prepare(`WITH ${DAILY_OVERVIEW_ELIGIBLE_SQL}
    SELECT type,id,title,date
    FROM eligible
    WHERE date <= ?
    ORDER BY date ASC,type ASC,id ASC,created_at ASC`).all(upper) as DailyOverviewItem[];
  for (const row of rows) {
    const group: DailyOverviewGroup | null = row.date < localDate
      ? "overdue"
      : row.date === localDate
        ? "today"
        : tomorrowDate !== null && row.date === tomorrowDate ? "tomorrow" : null;
    if (group) groups[group].push(row);
  }
  return groups;
}

/**
 * Digest-only bounded projection: complete counts are aggregated by SQLite
 * while a separate query returns at most five title rows from the same CTE.
 */
export function dailyDigestForDate(
  localDate: string,
  database: Database.Database = db,
): DailyDigestProjection {
  if (!validCalendarDate(localDate)) throw new Error("invalid local date");
  const tomorrowDate = addCalendarDays(localDate, 1);
  const tomorrow = tomorrowDate ?? localDate;
  const counts = database.prepare(DAILY_DIGEST_COUNTS_SQL).get(
    localDate, localDate, tomorrow, tomorrow,
  ) as Omit<DailyDigestProjection, "titles">;
  const titles = (database.prepare(DAILY_DIGEST_TITLES_SQL).all(
    tomorrow, localDate, localDate,
  ) as { title: string }[]).map(({ title }) => title);
  for (const count of [counts.overdueCount, counts.todayCount, counts.tomorrowCount]) {
    if (!Number.isSafeInteger(count) || count < 0) throw new Error("invalid digest count");
  }
  return { ...counts, titles };
}
