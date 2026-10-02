import { SCHEDULE_TIME_ZONE_SET } from "../../../shared/scheduleTimezones";
import {
  isCanonicalDate,
  isCanonicalInstant,
  type WeekRecord,
  type WeekResponse,
  type WeekValidationContext,
} from "../../../shared/weekContract";
import { parsePushStatus } from "../services/pushNotifications";

export type WeekTimezoneSelection =
  | { ok: true; timezone: string; source: "saved" | "detected" }
  | { ok: false };

/** Week deliberately accepts only exact members of ADR-74's frozen registry. */
export function selectWeekTimezone(
  pushStatus: unknown,
  detectedTimezone: unknown,
): WeekTimezoneSelection {
  try {
    const saved = parsePushStatus(pushStatus).preferences.timezone;
    if (saved !== null && SCHEDULE_TIME_ZONE_SET.has(saved)) {
      return { ok: true, timezone: saved, source: "saved" };
    }
  } catch {
    // A missing/malformed Push status falls through to exact browser detection.
  }
  return typeof detectedTimezone === "string" && SCHEDULE_TIME_ZONE_SET.has(detectedTimezone)
    ? { ok: true, timezone: detectedTimezone, source: "detected" }
    : { ok: false };
}

function utcDate(year: number, month: number, day: number): Date {
  const value = new Date(0);
  value.setUTCHours(0, 0, 0, 0);
  value.setUTCFullYear(year, month - 1, day);
  return value;
}

export function addWeekDays(value: string, days: number): string | null {
  if (!isCanonicalDate(value)) return null;
  const date = utcDate(Number(value.slice(0, 4)), Number(value.slice(5, 7)), Number(value.slice(8, 10)));
  date.setUTCDate(date.getUTCDate() + days);
  const year = date.getUTCFullYear();
  if (year < 1 || year > 9999) return null;
  return `${String(year).padStart(4, "0")}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const dateTimeFormatters = new Map<string, Intl.DateTimeFormat>();
function dateTimeFormatter(timezone: string): Intl.DateTimeFormat {
  let formatter = dateTimeFormatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA-u-ca-gregory-nu-latn", {
      timeZone: timezone,
      calendar: "gregory",
      numberingSystem: "latn",
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    dateTimeFormatters.set(timezone, formatter);
  }
  return formatter;
}

function zonedParts(epochMs: number, timezone: string): ZonedParts | null {
  try {
    const parts = new Map(
      dateTimeFormatter(timezone)
        .formatToParts(new Date(epochMs))
        .map((part) => [part.type, part.value]),
    );
    const result = {
      year: Number(parts.get("year")),
      month: Number(parts.get("month")),
      day: Number(parts.get("day")),
      hour: Number(parts.get("hour")),
      minute: Number(parts.get("minute")),
      second: Number(parts.get("second")),
    };
    return Object.values(result).every(Number.isInteger) ? result : null;
  } catch {
    return null;
  }
}

const offsetFormatters = new Map<string, Intl.DateTimeFormat>();
function offsetAt(epochMs: number, timezone: string): number | null {
  let formatter = offsetFormatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", { timeZone: timezone, timeZoneName: "longOffset" });
    offsetFormatters.set(timezone, formatter);
  }
  const name = formatter.formatToParts(new Date(epochMs)).find((part) => part.type === "timeZoneName")?.value;
  if (name === "GMT") return 0;
  const match = /^GMT([+-])(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(name ?? "");
  if (!match) return null;
  const seconds = Number(match[2]) * 3600 + Number(match[3]) * 60 + Number(match[4] ?? 0);
  return (match[1] === "+" ? 1 : -1) * seconds * 1000;
}

/** Resolve an exact local midnight without assuming every local day is 24 hours. */
export function resolveWeekMidnight(date: string, timezone: string): string | null {
  if (!isCanonicalDate(date) || !SCHEDULE_TIME_ZONE_SET.has(timezone)) return null;
  const target = utcDate(Number(date.slice(0, 4)), Number(date.slice(5, 7)), Number(date.slice(8, 10))).getTime();
  let candidate = target;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const offset = offsetAt(candidate, timezone);
    if (offset === null) return null;
    const next = target - offset;
    if (next === candidate) break;
    candidate = next;
  }
  const actual = zonedParts(candidate, timezone);
  if (!actual || actual.year !== Number(date.slice(0, 4)) || actual.month !== Number(date.slice(5, 7)) ||
      actual.day !== Number(date.slice(8, 10)) || actual.hour !== 0 || actual.minute !== 0 || actual.second !== 0) {
    return null;
  }
  const instant = new Date(candidate).toISOString();
  return isCanonicalInstant(instant) ? instant : null;
}

export function createWeekContext(
  weekStart: string,
  timezone: string,
): WeekValidationContext | null {
  if (!isCanonicalDate(weekStart) || !SCHEDULE_TIME_ZONE_SET.has(timezone)) return null;
  const monday = utcDate(
    Number(weekStart.slice(0, 4)),
    Number(weekStart.slice(5, 7)),
    Number(weekStart.slice(8, 10)),
  );
  if (monday.getUTCDay() !== 1) return null;
  const dates: string[] = [];
  for (let offset = 0; offset <= 7; offset += 1) {
    const value = addWeekDays(weekStart, offset);
    if (!value) return null;
    dates.push(value);
  }
  const midnights = dates.map((date) => resolveWeekMidnight(date, timezone));
  if (midnights.some((value) => value === null)) return null;
  const midnightInstants = midnights as string[];
  if (midnightInstants.some((value, index) => index > 0 && Date.parse(value) <= Date.parse(midnightInstants[index - 1]))) {
    return null;
  }
  return {
    weekStart,
    timezone,
    dates: dates.slice(0, 7) as unknown as WeekValidationContext["dates"],
    midnightInstants: midnightInstants as unknown as WeekValidationContext["midnightInstants"],
    rangeStart: midnightInstants[0],
    rangeEnd: midnightInstants[7],
  };
}

export function mondayForInstant(now: Date, timezone: string): string | null {
  if (!SCHEDULE_TIME_ZONE_SET.has(timezone) || !Number.isFinite(now.getTime())) return null;
  const parts = zonedParts(now.getTime(), timezone);
  if (!parts) return null;
  const localDate = `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
  if (!isCanonicalDate(localDate)) return null;
  const day = utcDate(parts.year, parts.month, parts.day).getUTCDay();
  return addWeekDays(localDate, -((day + 6) % 7));
}

export function formatWeekDay(date: string, timezone: string): string {
  const instant = resolveWeekMidnight(date, timezone);
  if (!instant) return date;
  return new Intl.DateTimeFormat(undefined, {
    timeZone: timezone,
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(new Date(instant));
}

export function formatWeekTime(instant: string, timezone: string): string {
  return new Intl.DateTimeFormat(undefined, {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(instant));
}

export function formatLocalDateTimeInput(instant: string, timezone: string): string {
  const parts = zonedParts(Date.parse(instant), timezone);
  if (!parts || parts.year < 1 || parts.year > 9999) return "";
  return `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}T${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}`;
}

export function weekIdentity(record: WeekRecord): string {
  return `${record.kind}:${record.id}`;
}

export function weekRecordTuple(
  record: WeekRecord,
  context: WeekValidationContext,
): readonly [number, 0 | 1 | 2, number] {
  const rangeStart = Date.parse(context.rangeStart);
  if (record.kind === "tracked") return [Math.max(Date.parse(record.startedAt), rangeStart), 2, record.id];
  if (record.kind === "goal") {
    return [Date.parse(context.midnightInstants[context.dates.indexOf(record.deadline.date)]), 1, record.id];
  }
  const fixed = record.fixed ? Math.max(Date.parse(record.fixed.startsAt), rangeStart) : null;
  const deadline = record.deadline
    ? Date.parse(context.midnightInstants[context.dates.indexOf(record.deadline.date)])
    : null;
  const anchor = fixed !== null && deadline !== null
    ? record.fixed!.contextDate === record.deadline!.date ? fixed : Math.min(fixed, deadline)
    : fixed ?? deadline!;
  return [anchor, 0, record.id];
}

function tupleAfter(left: readonly number[], right: readonly number[]): boolean {
  return left[0] > right[0] || left[0] === right[0] && (
    left[1] > right[1] || left[1] === right[1] && left[2] > right[2]
  );
}

export function appendWeekPage(
  current: WeekResponse | null,
  page: WeekResponse,
  context: WeekValidationContext,
): WeekResponse {
  if (!current) return page;
  if (current.weekStart !== page.weekStart || current.timezone !== page.timezone ||
      current.requestNow !== page.requestNow) {
    throw new Error("Week continuation changed its generation envelope");
  }
  const identities = new Set(current.records.map(weekIdentity));
  for (const record of page.records) {
    if (identities.has(weekIdentity(record))) throw new Error("Week continuation duplicated an identity");
    identities.add(weekIdentity(record));
  }
  if (current.records.length > 0 && page.records.length > 0 &&
      !tupleAfter(
        weekRecordTuple(page.records[0], context),
        weekRecordTuple(current.records[current.records.length - 1], context),
      )) {
    throw new Error("Week continuation is not strictly ordered");
  }
  return { ...page, records: [...current.records, ...page.records] };
}

export interface WeekTimedSegment {
  identity: string;
  kind: "fixed" | "tracked";
  title: string;
  titleTruncated: boolean;
  dayIndex: number;
  startsAt: string;
  endsAt: string;
  clippedStart: boolean;
  clippedEnd: boolean;
  top: number;
  height: number;
  lane: number;
  laneCount: number;
}

/** Deterministic day splitting and first-free-lane assignment; adjacency shares a lane. */
export function layoutWeekIntervals(
  records: readonly WeekRecord[],
  context: WeekValidationContext,
): WeekTimedSegment[] {
  const segments: WeekTimedSegment[] = [];
  for (const record of records) {
    const interval = record.kind === "tracked"
      ? { kind: "tracked" as const, start: record.startedAt, end: record.effectiveEndAt }
      : record.kind === "task" && record.fixed
        ? { kind: "fixed" as const, start: record.fixed.startsAt, end: record.fixed.endsAt }
        : null;
    if (!interval) continue;
    const sourceStart = Date.parse(interval.start);
    const sourceEnd = Date.parse(interval.end);
    for (let dayIndex = 0; dayIndex < 7; dayIndex += 1) {
      const dayStart = Date.parse(context.midnightInstants[dayIndex]);
      const dayEnd = Date.parse(context.midnightInstants[dayIndex + 1]);
      const start = Math.max(sourceStart, dayStart);
      const end = Math.min(sourceEnd, dayEnd);
      if (start >= end) continue;
      const duration = dayEnd - dayStart;
      segments.push({
        identity: weekIdentity(record),
        kind: interval.kind,
        title: record.title,
        titleTruncated: record.titleTruncated,
        dayIndex,
        startsAt: new Date(start).toISOString(),
        endsAt: new Date(end).toISOString(),
        clippedStart: sourceStart < dayStart,
        clippedEnd: sourceEnd > dayEnd,
        top: (start - dayStart) / duration,
        height: (end - start) / duration,
        lane: 0,
        laneCount: 1,
      });
    }
  }
  segments.sort((left, right) => left.dayIndex - right.dayIndex ||
    Date.parse(left.startsAt) - Date.parse(right.startsAt) ||
    Date.parse(left.endsAt) - Date.parse(right.endsAt) ||
    (left.kind === right.kind ? 0 : left.kind === "fixed" ? -1 : 1) ||
    left.identity.localeCompare(right.identity));
  for (let dayIndex = 0; dayIndex < 7; dayIndex += 1) {
    const day = segments.filter((segment) => segment.dayIndex === dayIndex);
    const laneEnds: number[] = [];
    for (const segment of day) {
      const start = Date.parse(segment.startsAt);
      let lane = laneEnds.findIndex((end) => end <= start);
      if (lane < 0) lane = laneEnds.length;
      laneEnds[lane] = Date.parse(segment.endsAt);
      segment.lane = lane;
    }
    const laneCount = Math.max(1, laneEnds.length);
    for (const segment of day) segment.laneCount = laneCount;
  }
  return segments;
}
