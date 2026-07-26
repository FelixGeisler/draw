import { addDays, localDate } from "./localDay.js";

/**
 * The recurrence schedule (#205, ADR-6 amended) — both halves in one file on
 * purpose, because they are one invariant: what a completion WRITES is
 * exactly what the deck WAITS for.
 *
 * Semantics chosen by the owner: `due_date` is the task's next occurrence —
 * the FIRST one as entered, every later one computed from the completion
 * ("every 4 days after I actually do it"). Nothing new is stored: the sleep
 * is derived from the due date at read time (ADR-2/ADR-17), so an occurrence
 * arrives with no write, exactly like a snooze wearing off.
 *
 * Both halves read the day off the USER'S calendar (`localDate`), never UTC
 * (PR #206 review). A due date is a local calendar day the user typed, and
 * the same `completeTask()` call already attributes that completion to the
 * local day for streaks and History — a UTC anchor made one completion two
 * different days depending on which subsystem asked. Concretely, in a UTC+2
 * zone a daily chore finished at 00:30 local was dated to the very day it
 * was done and came back at 02:30 the same night: the #205 symptom surviving
 * for late-night work.
 *
 * `offsetMinutes` is injectable in both functions (the ADR-21 `localDayOf`
 * pattern) so unit tests can pin any zone's behavior on any machine; every
 * production caller omits it and gets the server's own DST-correct offset.
 */

/**
 * The next occurrence of a recurring task completed at `now`: the user's
 * calendar day of the completion plus the interval, as a YYYY-MM-DD due date.
 *
 * The arithmetic is date-string math (`addDays`): the pre-#205 form did
 * `next.setDate(next.getDate() + n)` on a Date and then formatted with
 * `toISOString()`, mixing the local and UTC clocks — `setDate` preserves the
 * local wall-clock time, so an interval spanning a DST transition moved the
 * instant by an hour and the resulting date landed a day early (risk R3, and
 * shipped once already in stats).
 */
export function nextOccurrence(now: Date, intervalDays: number, offsetMinutes?: number): string {
  return addDays(localDate(now, offsetMinutes), intervalDays);
}

/**
 * Derived deck exclusion: a recurring task whose next occurrence has not
 * arrived yet is not a candidate. Two deliberate non-applications:
 *
 *   - a NON-recurring task with a future due date stays fully drawable —
 *     doing something before it is due is the whole point of the deck;
 *   - a recurring task with NO due date has no schedule to wait for and
 *     stays always-drawable, exactly as before #205.
 *
 * Mirrored by the client (`client/src/lib/drawable.ts`) and pinned by
 * `shared/drawableVectors.ts`, which both suites run.
 */
export function isAwaitingNextOccurrence(
  recurEveryDays: number | null | undefined,
  dueDate: string | null | undefined,
  now: Date,
  offsetMinutes?: number,
): boolean {
  if (recurEveryDays == null || recurEveryDays <= 0) return false;
  if (dueDate == null) return false;
  return dueDate > localDate(now, offsetMinutes);
}
