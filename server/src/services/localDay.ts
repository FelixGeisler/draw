/**
 * Day strings — the one home of "which day is it" and of date-only
 * arithmetic, so the rules cannot drift into private copies (the client
 * mirrors this file as `lib/localDay.ts`).
 *
 * `localDate` is deliberately local: "today" is the user's own calendar day.
 * Everything else in the codebase is UTC — user-day concepts (streak days,
 * History buckets, due dates and the recurrence schedule they drive) are the
 * documented exception, and they must all answer "which day was that?" the
 * same way for one instant. Since #219 they all answer it HERE: the streak's
 * former SQLite `date(..., 'localtime')` reads were the last second home, and
 * SQLite's localtime (the C runtime's) does not even agree with JS on Windows
 * under a pinned IANA `TZ`.
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

/** Canonical date-only value accepted by deadline-state features. */
export const CALENDAR_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Validate the complete proleptic-Gregorian YYYY-MM-DD domain. Parsing with
 * Date is deliberately avoided: engines normalize impossible dates and have
 * special handling around years 0..99.
 */
export function validCalendarDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = CALENDAR_DATE.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= days[month - 1];
}

/** Add whole calendar days without crossing the supported year bounds. */
export function addCalendarDays(value: string, amount: number): string | null {
  if (!validCalendarDate(value) || !Number.isInteger(amount)) return null;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCDate(date.getUTCDate() + amount);
  const nextYear = date.getUTCFullYear();
  if (nextYear < 1 || nextYear > 9999) return null;
  return `${String(nextYear).padStart(4, "0")}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

/** The shared strict IANA timezone boundary used by Push and daily overview. */
export function validTimeZone(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 128 ||
    [...value].some((character) => character.charCodeAt(0) > 0x7f)
  ) return false;
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
}

export function createZonedFormatter(timezone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    calendar: "iso8601",
    numberingSystem: "latn",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
}

export interface ZonedMinute {
  date: string;
  time: string;
  dateTime: string;
}

/** Extract canonical local date/minute fields for an instant in one IANA zone. */
export function zonedMinute(formatter: Intl.DateTimeFormat, instant: Date): ZonedMinute {
  const values = new Map(formatter.formatToParts(instant).map((part) => [part.type, part.value]));
  const yearPart = values.get("year");
  const month = values.get("month");
  const day = values.get("day");
  const hour = values.get("hour");
  const minute = values.get("minute");
  if (!yearPart || !month || !day || !hour || !minute) throw new Error("timezone-format-unavailable");
  const year = Number(yearPart);
  if (!Number.isInteger(year) || year < 1 || year > 9999) throw new Error("timezone-format-unavailable");
  const date = `${String(year).padStart(4, "0")}-${month}-${day}`;
  const time = `${hour}:${minute}`;
  return { date, time, dateTime: `${date}T${time}` };
}

export function zonedLocalDate(timezone: string, instant: Date): string {
  return zonedMinute(createZonedFormatter(timezone), instant).date;
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
  const result = addCalendarDays(dateStr, n);
  if (result === null) throw new RangeError("date addition is outside the supported Gregorian range");
  return result;
}

/**
 * The half-open instant range [start, end) of a local calendar day, as
 * ISO-Z strings comparable to stored `toISOString()` timestamps (#219).
 *
 * Exists so SQL can filter "today's rows" without `date(..., 'localtime')`:
 * SQLite's localtime is the C runtime's, and on Windows the C runtime cannot
 * read an IANA `TZ` like Europe/Berlin — so under the test suite's pinned
 * zone, SQLite and JS disagreed about "today" for the two hours after local
 * midnight while agreeing all day long. Deriving the boundaries HERE keeps
 * localDay.ts the one home of "which day is it" and leaves SQL comparing
 * plain instants.
 *
 * `new Date("YYYY-MM-DDT00:00:00")` (no Z) resolves with the server's offset
 * for THAT date, so the boundaries stay correct across DST transitions —
 * a 23- or 25-hour day gets its true bounds, not midnight ± a fixed offset.
 */
export function localDayBounds(day: string): { startIso: string; endIso: string } {
  return {
    startIso: new Date(`${day}T00:00:00`).toISOString(),
    endIso: new Date(`${addDays(day, 1)}T00:00:00`).toISOString(),
  };
}
