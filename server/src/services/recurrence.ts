import { addDays, utcDate } from "./localDay.js";

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
 */

/**
 * The next occurrence of a recurring task completed at `now`: the
 * completion's UTC date plus the interval, as a YYYY-MM-DD due date.
 *
 * UTC on both sides deliberately — this is the same clock
 * `isAwaitingNextOccurrence` compares against, so the day the completion
 * writes is the day the card comes back. The arithmetic is date-string math
 * (`addDays`): the pre-#205 form did `next.setDate(next.getDate() + n)` on a
 * Date and then formatted with `toISOString()`, mixing the local and UTC
 * clocks — `setDate` preserves the local wall-clock time, so an interval
 * spanning a DST transition moved the instant by an hour and the UTC date
 * landed a day early (risk R3, and shipped once already in stats).
 */
export function nextOccurrence(now: Date, intervalDays: number): string {
  return addDays(utcDate(now), intervalDays);
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
): boolean {
  if (recurEveryDays == null || recurEveryDays <= 0) return false;
  if (dueDate == null) return false;
  return dueDate > utcDate(now);
}
