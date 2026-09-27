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

export interface DailyDigestCounts {
  overdueCount: number;
  todayCount: number;
  tomorrowCount: number;
}

export interface DailyDigestProjection extends DailyDigestCounts {
  titles: string[];
}

// Both public projections are built from this one title-free eligible relation.
// Date and positive safe-integer ID validation deliberately happen in SQL so
// malformed restored rows cannot enter either projection or cross the JS ID
// precision boundary.
export const DAILY_OVERVIEW_ELIGIBLE_SQL = `
  eligible(type,id,date,created_at) AS MATERIALIZED (
    SELECT 'task', id, due_date, created_at
    FROM tasks
    WHERE status = 'open' AND due_date IS NOT NULL
      AND id BETWEEN 1 AND 9007199254740991
      AND length(due_date)=10
      AND due_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
      AND substr(due_date,1,4) <> '0000'
      AND strftime('%Y-%m-%d', due_date) = due_date
    UNION ALL
    SELECT 'goal', id, target_date, created_at
    FROM goals
    WHERE status = 'active' AND target_date IS NOT NULL
      AND id BETWEEN 1 AND 9007199254740991
      AND length(target_date)=10
      AND target_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
      AND substr(target_date,1,4) <> '0000'
      AND strftime('%Y-%m-%d', target_date) = target_date
  )`;

export const DAILY_DIGEST_COUNTS_SQL = `WITH ${DAILY_OVERVIEW_ELIGIBLE_SQL}
  SELECT
    COALESCE(SUM(CASE WHEN date < ? THEN 1 ELSE 0 END),0) AS overdueCount,
    COALESCE(SUM(CASE WHEN date = ? THEN 1 ELSE 0 END),0) AS todayCount,
    COALESCE(SUM(CASE WHEN ? IS NOT NULL AND date = ? THEN 1 ELSE 0 END),0) AS tomorrowCount
  FROM eligible
  WHERE date <= ?`;

// Select and order at most five title-free identities first. Only those bounded
// identities are allowed to dereference title values from their source table.
export const DAILY_DIGEST_TITLES_SQL = `WITH ${DAILY_OVERVIEW_ELIGIBLE_SQL},
  selected(type,id,date,created_at) AS MATERIALIZED (
    SELECT type,id,date,created_at
    FROM eligible
    WHERE date <= ?
    ORDER BY CASE WHEN date < ? THEN 0 WHEN date = ? THEN 1 ELSE 2 END,
             date ASC, type ASC, id ASC, created_at ASC
    LIMIT 5
  )
  SELECT CASE type
    WHEN 'task' THEN (SELECT title FROM tasks WHERE tasks.id = selected.id)
    ELSE (SELECT title FROM goals WHERE goals.id = selected.id)
  END AS title
  FROM selected
  ORDER BY CASE WHEN date < ? THEN 0 WHEN date = ? THEN 1 ELSE 2 END,
           date ASC, type ASC, id ASC, created_at ASC`;

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
    SELECT type,id,
      CASE type
        WHEN 'task' THEN (SELECT title FROM tasks WHERE tasks.id = eligible.id)
        ELSE (SELECT title FROM goals WHERE goals.id = eligible.id)
      END AS title,
      date
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

/** Complete title-free counts for a digest local date. */
export function dailyDigestCountsForDate(
  localDate: string,
  database: Database.Database = db,
): DailyDigestCounts {
  if (!validCalendarDate(localDate)) throw new Error("invalid local date");
  const tomorrow = addCalendarDays(localDate, 1);
  const upper = tomorrow ?? localDate;
  const counts = database.prepare(DAILY_DIGEST_COUNTS_SQL).get(
    localDate, localDate, tomorrow, tomorrow, upper,
  ) as DailyDigestCounts;
  for (const count of [counts.overdueCount, counts.todayCount, counts.tomorrowCount]) {
    if (!Number.isSafeInteger(count) || count < 0) throw new Error("invalid digest count");
  }
  return counts;
}

/** Dereference no more than five titles after bounded identity selection. */
export function dailyDigestTitlesForDate(
  localDate: string,
  database: Database.Database = db,
): string[] {
  if (!validCalendarDate(localDate)) throw new Error("invalid local date");
  const upper = addCalendarDays(localDate, 1) ?? localDate;
  return (database.prepare(DAILY_DIGEST_TITLES_SQL).all(
    upper, localDate, localDate, localDate, localDate,
  ) as { title: string }[]).map(({ title }) => title);
}

/** Complete counts plus the independently bounded title projection. */
export function dailyDigestForDate(
  localDate: string,
  database: Database.Database = db,
): DailyDigestProjection {
  return {
    ...dailyDigestCountsForDate(localDate, database),
    titles: dailyDigestTitlesForDate(localDate, database),
  };
}
