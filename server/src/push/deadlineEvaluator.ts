import { addCalendarDays, type ZonedMinute } from "../services/localDay.js";

// Compatibility exports for the existing deadline scheduler. The neutral
// implementations live in services/localDay so the daily overview and the
// later digest replacement cannot drift into parallel calendar rules.
export {
  CALENDAR_DATE as DEADLINE_DATE,
  addCalendarDays,
  createZonedFormatter,
  validCalendarDate,
  validTimeZone,
  zonedMinute,
  type ZonedMinute,
} from "../services/localDay.js";

export const QUARTER_HOUR = /^(?:[01]\d|2[0-3]):(?:00|15|30|45)$/;
export const LEAD_DAYS = new Set([0, 1, 2, 3, 7, 14, 30]);

export interface DeadlineTiming {
  leadDays: number;
  sendTime: string;
  timezone: string | null;
  quietStart: string | null;
  quietEnd: string | null;
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
