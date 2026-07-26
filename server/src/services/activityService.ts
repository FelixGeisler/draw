import { db } from "../db.js";
import { addDays, localDate } from "./localDay.js";
import { MINUTES_EXPR } from "./statsService.js";

// Activity history behind the Stats page's History calendar (#53; a
// contribution calendar since #174, originally the house-of-cards skyline):
// a browsable per-day record of started and completed tasks, derived entirely
// from time_entries and completions — no new write path, no stored history
// (ADR-21). This read model is UI-agnostic and unchanged across #174.

export interface ActivityEntryRow {
  taskId: number;
  startedAt: string; // UTC ISO
  minutes: number; // MINUTES_EXPR: running entries count up to now
}

export interface ActivityCompletionRow {
  taskId: number;
  completedAt: string; // UTC ISO
  xpAwarded: number;
  wasDrawn: number; // SQLite 0 | 1
}

export interface ActivityTaskMeta {
  taskId: number;
  title: string;
  categoryId: number;
  categoryColor: string;
  effortMinutes: number | null;
  /**
   * Live task rating from the tasks join (like title) — with wasDrawn it lets
   * the client derive holo/silver card rarity (#62); never snapshotted.
   */
  impact: number;
}

export interface ActivityCard {
  taskId: number;
  title: string;
  categoryId: number;
  categoryColor: string;
  effortMinutes: number | null;
  impact: number;
  trackedMinutes: number;
  /** Upright (completed on this local day) vs face-down (worked, not done). */
  completed: boolean;
  xpAwarded: number;
  wasDrawn: boolean;
}

export interface ActivityDay {
  date: string; // local calendar day, YYYY-MM-DD
  cards: ActivityCard[];
  totals: { started: number; completed: number; minutes: number; xp: number };
}

// Date-only arithmetic moved to localDay.ts with #205 — the recurrence
// schedule needs the same helper and must not import this read model. Still
// exported from here: it has been activityService's helper since #53.
export { addDays };

/**
 * Local calendar day of a UTC instant. The History calendar is a human-facing
 * record — a task started 23:30 local belongs to that evening's cell even
 * though its UTC date is already tomorrow (same choice as the streak logic's
 * date(..., 'localtime') in gamificationService, NOT the UTC bucketing of
 * stats.ts). `offsetMinutes` is injectable so unit tests can pin the
 * midnight-boundary behavior on any machine; it defaults to the server's own
 * offset at that instant, which is DST-correct per timestamp.
 *
 * The rule itself lives in localDay.ts since #205 (PR #206 review): the
 * recurrence schedule must answer "which day was that completion?" exactly
 * like the History buckets and the streak, so there is one implementation.
 */
export function localDayOf(iso: string, offsetMinutes?: number): string {
  return localDate(new Date(iso), offsetMinutes);
}

/** Per-(task, day) accumulator while folding entries and completions. */
interface CardAcc {
  taskId: number;
  day: string;
  firstActivity: string; // earliest entry start / completion — tower stacking order
  minutes: number;
  completed: boolean;
  xp: number;
  wasDrawn: boolean;
}

/**
 * Pure card derivation (no DB — the buildEstimation pattern). Card set for
 * local day D = tasks with a time entry started on D UNION tasks completed on
 * D. The union matters: a completion without any timer that day (PATCH status
 * to done) still earns an upright card. A day with work but no completion
 * yields a face-down card — permanently: completing on a later day earns THAT
 * day an upright card while the earlier face-down card stays. One card per
 * (task, day) no matter how many entries; minutes sum. Every day in
 * [from, to] appears — an empty day is a visible (faint, level-0) tile in the
 * History calendar, which is the point. Callers must supply meta for every
 * referenced task.
 */
export function buildActivityDays(
  entries: ActivityEntryRow[],
  completions: ActivityCompletionRow[],
  tasks: ActivityTaskMeta[],
  from: string,
  to: string,
  offsetMinutes?: number,
): ActivityDay[] {
  const meta = new Map(tasks.map((t) => [t.taskId, t]));

  const accs = new Map<string, CardAcc>();
  const accFor = (taskId: number, day: string, at: string): CardAcc => {
    const key = `${day}|${taskId}`;
    let acc = accs.get(key);
    if (!acc) {
      acc = { taskId, day, firstActivity: at, minutes: 0, completed: false, xp: 0, wasDrawn: false };
      accs.set(key, acc);
    } else if (at < acc.firstActivity) {
      acc.firstActivity = at;
    }
    return acc;
  };

  for (const e of entries) {
    // Entries spanning midnight attribute to their START day, consistent with
    // the stats queries filtering on started_at.
    const day = localDayOf(e.startedAt, offsetMinutes);
    if (day < from || day > to) continue;
    accFor(e.taskId, day, e.startedAt).minutes += e.minutes;
  }
  for (const co of completions) {
    const day = localDayOf(co.completedAt, offsetMinutes);
    if (day < from || day > to) continue;
    const acc = accFor(co.taskId, day, co.completedAt);
    acc.completed = true;
    acc.xp += co.xpAwarded; // recurring tasks can complete twice a day
    if (co.wasDrawn) acc.wasDrawn = true;
  }

  const byDay = new Map<string, CardAcc[]>();
  for (const acc of accs.values()) {
    const list = byDay.get(acc.day);
    if (list) list.push(acc);
    else byDay.set(acc.day, [acc]);
  }

  const days: ActivityDay[] = [];
  for (let day = from; day <= to; day = addDays(day, 1)) {
    const dayAccs = (byDay.get(day) ?? []).sort(
      (a, b) =>
        (a.firstActivity < b.firstActivity ? -1 : a.firstActivity > b.firstActivity ? 1 : 0) ||
        a.taskId - b.taskId,
    );
    const cards = dayAccs.map((acc) => {
      const m = meta.get(acc.taskId)!;
      return {
        taskId: acc.taskId,
        title: m.title,
        categoryId: m.categoryId,
        categoryColor: m.categoryColor,
        effortMinutes: m.effortMinutes,
        impact: m.impact,
        trackedMinutes: Math.round(acc.minutes),
        completed: acc.completed,
        xpAwarded: acc.xp,
        wasDrawn: acc.wasDrawn,
      };
    });
    days.push({
      date: day,
      cards,
      // `started` = cards laid that day (incl. completion-only ones) — the
      // History calendar's intensity level and empty-state check ride on it.
      totals: {
        started: cards.length,
        completed: cards.filter((c) => c.completed).length,
        minutes: Math.round(dayAccs.reduce((sum, a) => sum + a.minutes, 0)),
        xp: dayAccs.reduce((sum, a) => sum + a.xp, 0),
      },
    });
  }
  return days;
}

/**
 * Fetch + derive for GET /api/activity. SQL filters on a UTC window widened
 * by a day on each side (a local day lies at most ±14h around its UTC date;
 * ISO timestamps compare lexicographically against date-only bounds), then
 * buildActivityDays buckets exactly by local day. Keeping the bucketing in
 * one place (localDayOf) avoids mixed SQLite-vs-JS timezone edge cases.
 */
export function computeActivity(from: string, to: string): ActivityDay[] {
  const lo = addDays(from, -1);
  const hi = addDays(to, 2);

  const entries = db
    .prepare(
      `SELECT e.task_id AS taskId, e.started_at AS startedAt, ${MINUTES_EXPR} AS minutes
       FROM time_entries e WHERE e.started_at >= ? AND e.started_at < ?`,
    )
    .all(lo, hi) as ActivityEntryRow[];

  // Drawn-ness reads was_drawn AND NOT was_warmup, matching the gamification
  // surface (ADR-30): a warm-up deal earns no History-calendar rarity or 🃏 either.
  const completions = db
    .prepare(
      `SELECT co.task_id AS taskId, co.completed_at AS completedAt,
              co.xp_awarded AS xpAwarded,
              (co.was_drawn AND NOT co.was_warmup) AS wasDrawn
       FROM completions co WHERE co.completed_at >= ? AND co.completed_at < ?`,
    )
    .all(lo, hi) as ActivityCompletionRow[];

  const tasks = db
    .prepare(
      `SELECT t.id AS taskId, t.title, t.category_id AS categoryId,
              c.color AS categoryColor, t.effort_minutes AS effortMinutes, t.impact
       FROM tasks t JOIN categories c ON c.id = t.category_id
       WHERE t.id IN (
         SELECT task_id FROM time_entries WHERE started_at >= ? AND started_at < ?
         UNION
         SELECT task_id FROM completions WHERE completed_at >= ? AND completed_at < ?
       )`,
    )
    .all(lo, hi, lo, hi) as ActivityTaskMeta[];

  return buildActivityDays(entries, completions, tasks, from, to);
}
