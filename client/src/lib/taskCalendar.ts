import type { Task } from "../api/types";
import { addDays } from "./localDay";

export interface TaskCalendarDay {
  date: string;
  tasks: Task[];
}

export interface TaskCalendarData {
  scheduled: Task[];
  overdue: Task[];
  monthDays: TaskCalendarDay[];
}

/** The YYYY-MM month containing a local YYYY-MM-DD calendar day. */
export function monthForDay(day: string): string {
  return day.slice(0, 7);
}

export function isDayInMonth(day: string, month: string): boolean {
  return monthForDay(day) === month;
}

function byTitle(a: Task, b: Task): number {
  return a.title.localeCompare(b.title) || a.id - b.id;
}

/**
 * Flatten the Tasks-page payload exactly once. The API nests one level of
 * subtasks; recurrence is deliberately not expanded — its current dueDate is
 * the one schedule item supplied by ADR-6.
 */
export function scheduledTasks(roots: Task[]): Task[] {
  const seen = new Set<number>();
  const result: Task[] = [];
  for (const root of roots) {
    for (const task of [root, ...(root.subtasks ?? [])]) {
      if (seen.has(task.id)) continue;
      seen.add(task.id);
      if (task.status === "open" && task.dueDate != null) result.push(task);
    }
  }
  return result;
}

export function deriveTaskCalendar(
  roots: Task[],
  selectedMonth: string,
  today: string,
): TaskCalendarData {
  const scheduled = scheduledTasks(roots);
  const overdue = scheduled
    .filter((task) => task.dueDate! < today)
    .sort((a, b) => a.dueDate!.localeCompare(b.dueDate!) || byTitle(a, b));

  const byDay = new Map<string, Task[]>();
  for (const task of scheduled) {
    if (!isDayInMonth(task.dueDate!, selectedMonth)) continue;
    byDay.set(task.dueDate!, [...(byDay.get(task.dueDate!) ?? []), task]);
  }
  const monthDays = [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, tasks]) => ({ date, tasks: tasks.sort(byTitle) }));

  return { scheduled, overdue, monthDays };
}

/** Every dated cell in a Monday-first month grid, with null leading/trailing pads. */
export function monthGridDays(month: string): Array<string | null> {
  const first = `${month}-01`;
  const firstDate = new Date(`${first}T00:00:00Z`);
  const leading = (firstDate.getUTCDay() + 6) % 7;
  const nextMonth = new Date(
    Date.UTC(firstDate.getUTCFullYear(), firstDate.getUTCMonth() + 1, 1),
  );
  const last = addDays(nextMonth.toISOString().slice(0, 10), -1);
  const days = Number(last.slice(8, 10));
  const cells: Array<string | null> = [
    ...Array.from<null>({ length: leading }).fill(null),
    ...Array.from({ length: days }, (_, index) => addDays(first, index)),
  ];
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}

export function shiftMonth(month: string, delta: number): string {
  const date = new Date(`${month}-01T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + delta);
  return date.toISOString().slice(0, 7);
}
