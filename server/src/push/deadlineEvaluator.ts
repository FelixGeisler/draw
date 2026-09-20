export const DEADLINE_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
export const QUARTER_HOUR = /^(?:[01]\d|2[0-3]):(?:00|15|30|45)$/;
export const LEAD_DAYS = new Set([0, 1, 2, 3, 7, 14, 30]);

export interface DeadlineTiming {
  leadDays: number;
  sendTime: string;
  timezone: string | null;
  quietStart: string | null;
  quietEnd: string | null;
}

export interface ZonedMinute {
  date: string;
  time: string;
  dateTime: string;
}

export function validCalendarDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = DEADLINE_DATE.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1) return false;
  const days = [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28,
    31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= days[month - 1];
}

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

export function validTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > 128 ||
    [...value].some((character) => character.charCodeAt(0) > 0x7f)) return false;
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

export function inQuietHours(time: string, start: string | null, end: string | null): boolean {
  if (start === null || end === null) return false;
  return start < end ? time >= start && time < end : time >= start || time < end;
}

export function scheduledDateTime(deadline: string, timing: DeadlineTiming): string | null {
  const date = addCalendarDays(deadline, -timing.leadDays);
  return date === null ? null : `${date}T${timing.sendTime}`;
}

export function occurrenceEligible(
  deadline: string,
  timing: DeadlineTiming,
  now: ZonedMinute,
): boolean {
  const scheduled = scheduledDateTime(deadline, timing);
  return scheduled !== null && now.date <= deadline && now.dateTime >= scheduled &&
    !inQuietHours(now.time, timing.quietStart, timing.quietEnd);
}
