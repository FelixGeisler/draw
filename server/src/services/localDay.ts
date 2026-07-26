/**
 * Day strings — the one home of "which day is it" and of date-only
 * arithmetic, so the rules cannot drift into private copies (the client
 * mirrors this file as `lib/localDay.ts`).
 *
 * `localDate` is deliberately local (`getFullYear`/`getMonth`/`getDate`,
 * never `getUTC*`): "today" is the user's own calendar day, the same
 * convention the streak's SQLite `localtime` reads use. Everything else in
 * the codebase is UTC — user-day concepts are the documented exception.
 */
export function localDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Date-only arithmetic in UTC — safe for YYYY-MM-DD strings (stats.ts
 * pattern). Lived in activityService until #205, which needed the same
 * helper for the recurrence schedule: doing the addition on a Date with
 * `setDate` instead preserves the LOCAL wall-clock time, so an interval
 * spanning a DST transition shifts the instant by an hour and the UTC date
 * can land a day off (risk R3).
 */
export function addDays(dateStr: string, n: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** UTC calendar date of an instant — the clock `due_date` is written in. */
export function utcDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
