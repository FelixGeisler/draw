import { SCHEDULE_TIME_ZONE_SET, type ScheduleTimeZoneId } from "../../shared/scheduleTimezones.js";
import { isCanonicalDate, isCanonicalInstant } from "../../shared/weekContract.js";
import { resolveWallMinute } from "./services/fixedSlots.js";

export interface ResolvedWeek {
  weekStart: string;
  timezone: ScheduleTimeZoneId;
  dates: readonly [string, string, string, string, string, string, string];
  midnightInstants: readonly [string, string, string, string, string, string, string, string];
  midnightMs: readonly [number, number, number, number, number, number, number, number];
  rangeStart: string;
  rangeEnd: string;
  rangeStartMs: number;
  rangeEndMs: number;
}

function utcDate(year: number, month: number, day: number): Date {
  const result = new Date(0);
  result.setUTCHours(0, 0, 0, 0);
  result.setUTCFullYear(year, month - 1, day);
  return result;
}

function addDate(date: string, days: number): string | null {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const day = Number(date.slice(8, 10));
  const value = utcDate(year, month, day);
  value.setUTCDate(value.getUTCDate() + days);
  const nextYear = value.getUTCFullYear();
  if (nextYear < 1 || nextYear > 9999) return null;
  return `${String(nextYear).padStart(4, "0")}-${String(value.getUTCMonth() + 1).padStart(2, "0")}-${String(value.getUTCDate()).padStart(2, "0")}`;
}

export function resolveWeek(weekStart: unknown, timezone: unknown): ResolvedWeek | null {
  if (!isCanonicalDate(weekStart) || typeof timezone !== "string" || !SCHEDULE_TIME_ZONE_SET.has(timezone)) {
    return null;
  }
  const monday = utcDate(
    Number(weekStart.slice(0, 4)),
    Number(weekStart.slice(5, 7)),
    Number(weekStart.slice(8, 10)),
  );
  if (monday.getUTCDay() !== 1) return null;
  const values: string[] = [];
  for (let offset = 0; offset <= 7; offset += 1) {
    const value = addDate(weekStart, offset);
    if (!value) return null;
    values.push(value);
  }
  const midnightInstants: string[] = [];
  try {
    for (const value of values) {
      midnightInstants.push(
        resolveWallMinute(`${value}T00:00`, timezone as ScheduleTimeZoneId, "Week midnight").instant,
      );
    }
  } catch {
    return null;
  }
  if (midnightInstants.some((value) => !isCanonicalInstant(value))) return null;
  const midnightMs = midnightInstants.map(Date.parse);
  if (midnightMs.some((value, index) => index > 0 && value <= midnightMs[index - 1])) return null;
  return {
    weekStart,
    timezone: timezone as ScheduleTimeZoneId,
    dates: values.slice(0, 7) as unknown as ResolvedWeek["dates"],
    midnightInstants: midnightInstants as unknown as ResolvedWeek["midnightInstants"],
    midnightMs: midnightMs as unknown as ResolvedWeek["midnightMs"],
    rangeStart: midnightInstants[0],
    rangeEnd: midnightInstants[7],
    rangeStartMs: midnightMs[0],
    rangeEndMs: midnightMs[7],
  };
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timezone: string): Intl.DateTimeFormat {
  let current = formatters.get(timezone);
  if (!current) {
    current = new Intl.DateTimeFormat("en-CA-u-ca-gregory-nu-latn", {
      timeZone: timezone,
      calendar: "gregory",
      numberingSystem: "latn",
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    formatters.set(timezone, current);
  }
  return current;
}

/**
 * Project a canonical source instant to its local source date. ICU renders
 * ISO year zero as Gregorian year 1, so the two representational boundary
 * crossings are detected from the UTC/local month transition and return null.
 */
export function contextDateForInstant(instant: string, timezone: ScheduleTimeZoneId): string | null {
  if (!isCanonicalInstant(instant)) throw new Error("fixed startsAt is not canonical");
  const source = new Date(instant);
  const parts = new Map(formatter(timezone).formatToParts(source).map((part) => [part.type, part.value]));
  const year = Number(parts.get("year"));
  const month = Number(parts.get("month"));
  const day = Number(parts.get("day"));
  const utcYear = source.getUTCFullYear();
  if (utcYear === 1 && source.getUTCMonth() === 0 && month === 12) return null;
  if (utcYear === 9999 && source.getUTCMonth() === 11 && month === 1) return null;
  if (!Number.isInteger(year) || year < 1 || year > 9999) return null;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
