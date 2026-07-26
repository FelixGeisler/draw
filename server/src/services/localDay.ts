/**
 * Day strings — the one home of "which day is it" and of date-only
 * arithmetic, so the rules cannot drift into private copies (the client
 * mirrors this file as `lib/localDay.ts`).
 *
 * `localDate` is deliberately local: "today" is the user's own calendar day,
 * the same convention the streak's SQLite `localtime` reads use. Everything
 * else in the codebase is UTC — user-day concepts (streak days, History
 * buckets, due dates and the recurrence schedule they drive) are the
 * documented exception, and they must all answer "which day was that?" the
 * same way for one instant.
 *
 * `offsetMinutes` defaults to the machine's own UTC offset AT THAT INSTANT
 * (so it is DST-correct per timestamp) and is injectable so unit tests can
 * pin any timezone's behavior on any machine — the ADR-21 `localDayOf`
 * pattern, which now delegates here.
 */
export function localDate(d: Date, offsetMinutes?: number): string {
  const offset = offsetMinutes ?? -d.getTimezoneOffset();
  return new Date(d.getTime() + offset * 60_000).toISOString().slice(0, 10);
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
