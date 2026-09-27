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

interface CandidateRow extends DailyOverviewItem {}

const CANDIDATES_SQL = `
  SELECT 'task' AS type, id, title, due_date AS date
  FROM tasks
  WHERE status = 'open' AND due_date IS NOT NULL
  UNION ALL
  SELECT 'goal' AS type, id, title, target_date AS date
  FROM goals
  WHERE status = 'active' AND target_date IS NOT NULL
`;

function compareItems(left: DailyOverviewItem, right: DailyOverviewItem): number {
  if (left.date !== right.date) return left.date < right.date ? -1 : 1;
  if (left.type !== right.type) return left.type < right.type ? -1 : 1;
  return left.id - right.id;
}

/**
 * Read and classify deadline state for an explicit local calendar date.
 * This is the neutral server-domain boundary shared by HTTP now and the
 * digest sender later. It performs no writes and deliberately ignores deck
 * drawability, hierarchy, snooze, sequential and availability-window state.
 */
export function dailyOverviewForDate(
  localDate: string,
  database: Database.Database = db,
): DailyOverviewGroups {
  if (!validCalendarDate(localDate)) throw new Error("invalid local date");
  const tomorrowDate = addCalendarDays(localDate, 1);
  const groups: DailyOverviewGroups = { overdue: [], today: [], tomorrow: [] };
  // At 9999-12-31 there is no representable tomorrow. Overdue and today are
  // still meaningful; no candidate can qualify for the absent next day.
  for (const row of database.prepare(CANDIDATES_SQL).all() as CandidateRow[]) {
    if (
      (row.type !== "goal" && row.type !== "task") ||
      !Number.isSafeInteger(row.id) ||
      row.id <= 0 ||
      typeof row.title !== "string" ||
      !validCalendarDate(row.date)
    ) continue;

    let group: DailyOverviewGroup | null = null;
    if (row.date < localDate) group = "overdue";
    else if (row.date === localDate) group = "today";
    else if (tomorrowDate !== null && row.date === tomorrowDate) group = "tomorrow";
    if (group !== null) groups[group].push({ type: row.type, id: row.id, title: row.title, date: row.date });
  }
  groups.overdue.sort(compareItems);
  groups.today.sort(compareItems);
  groups.tomorrow.sort(compareItems);
  return groups;
}
