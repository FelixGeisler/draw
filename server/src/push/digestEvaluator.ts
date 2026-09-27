import type Database from "better-sqlite3";
import { addCalendarDays, createZonedFormatter, validCalendarDate, validTimeZone, zonedMinute } from "../services/localDay.js";

export { addCalendarDays, createZonedFormatter, validTimeZone, zonedMinute } from "../services/localDay.js";

export const QUARTER_HOUR = /^(?:[01]\d|2[0-3]):(?:00|15|30|45)$/;
export const DIGEST_MAX_TTL_SECONDS = 10_800;

export interface DigestTiming {
  sendTime: string;
  timezone: string | null;
  quietStart: string | null;
  quietEnd: string | null;
}

export interface DigestWindow {
  localDate: string;
  start: Date;
  end: Date;
}

export interface DigestEligibility extends DigestWindow {
  ttl: number;
}

export function inQuietHours(time: string, start: string | null, end: string | null): boolean {
  if (start === null || end === null) return false;
  return start < end ? time >= start && time < end : time >= start || time < end;
}

export function readDigestTiming(database: Database.Database): DigestTiming | null {
  const rows = database.prepare(
    `SELECT key,value FROM settings WHERE key IN
     ('push_send_time','push_timezone','push_quiet_start','push_quiet_end')`,
  ).all() as { key: string; value: string | null }[];
  const values = new Map(rows.map(({ key, value }) => [key, value]));
  const timing: DigestTiming = {
    sendTime: values.get("push_send_time") ?? "",
    timezone: values.get("push_timezone") ?? null,
    quietStart: values.get("push_quiet_start") ?? null,
    quietEnd: values.get("push_quiet_end") ?? null,
  };
  const quietValid = timing.quietStart === null && timing.quietEnd === null ||
    typeof timing.quietStart === "string" && typeof timing.quietEnd === "string" &&
      QUARTER_HOUR.test(timing.quietStart) && QUARTER_HOUR.test(timing.quietEnd) &&
      timing.quietStart !== timing.quietEnd;
  return QUARTER_HOUR.test(timing.sendTime) &&
    (timing.timezone === null || validTimeZone(timing.timezone)) && quietValid ? timing : null;
}

export function validDigestTiming(value: DigestTiming): value is DigestTiming & { timezone: string } {
  const quietValid = value.quietStart === null && value.quietEnd === null ||
    typeof value.quietStart === "string" && typeof value.quietEnd === "string" &&
      QUARTER_HOUR.test(value.quietStart) && QUARTER_HOUR.test(value.quietEnd) &&
      value.quietStart !== value.quietEnd;
  return QUARTER_HOUR.test(value.sendTime) && validTimeZone(value.timezone) && quietValid;
}

/**
 * Resolve a wall minute in an IANA zone. Iterating chronological real minutes
 * gives the first overlap occurrence; if the requested minute is in a gap,
 * the first later wall minute on that local date is selected.
 */
export function resolveWallMinute(localDate: string, wallTime: string, timezone: string): Date | null {
  if (!validCalendarDate(localDate) || !QUARTER_HOUR.test(wallTime) || !validTimeZone(timezone)) {
    return null;
  }
  const formatter = createZonedFormatter(timezone);
  const nominal = Date.parse(`${localDate}T${wallTime}:00Z`);
  if (!Number.isFinite(nominal)) return null;
  const first = nominal - 36 * 60 * 60 * 1000;
  const last = nominal + 36 * 60 * 60 * 1000;
  const target = `${localDate}T${wallTime}`;
  for (let instant = first; instant <= last; instant += 60_000) {
    const local = zonedMinute(formatter, new Date(instant));
    if (local.date === localDate && local.dateTime >= target) return new Date(instant);
  }
  return null;
}

export function digestWindow(timing: DigestTiming, instant: Date): DigestWindow | null {
  if (!validDigestTiming(timing) || !Number.isFinite(instant.valueOf())) return null;
  const formatter = createZonedFormatter(timing.timezone);
  const localDate = zonedMinute(formatter, instant).date;
  const start = resolveWallMinute(localDate, timing.sendTime, timing.timezone);
  const nextDate = addCalendarDays(localDate, 1);
  if (!start || !nextDate) return null;
  const nextDay = resolveWallMinute(nextDate, "00:00", timing.timezone);
  if (!nextDay) return null;
  const elapsedEnd = new Date(start.valueOf() + DIGEST_MAX_TTL_SECONDS * 1000);
  return { localDate, start, end: elapsedEnd < nextDay ? elapsedEnd : nextDay };
}

export function evaluateDigestEligibility(timing: DigestTiming, instant: Date): DigestEligibility | null {
  const window = digestWindow(timing, instant);
  if (!window || instant < window.start || instant >= window.end) return null;
  const local = zonedMinute(createZonedFormatter(timing.timezone!), instant);
  if (inQuietHours(local.time, timing.quietStart, timing.quietEnd)) return null;
  const ttl = Math.floor((window.end.valueOf() - instant.valueOf()) / 1000);
  if (ttl < 1) return null;
  return { ...window, ttl: Math.min(DIGEST_MAX_TTL_SECONDS, ttl) };
}
