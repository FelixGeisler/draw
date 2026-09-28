export const WEEK_PAGE_RECORD_LIMIT = 100;
export const WEEK_IDENTITY_LOOKAHEAD_LIMIT = 101;
export const WEEK_JSON_BYTE_LIMIT = 131_072;
export const WEEK_CURSOR_CHARACTER_LIMIT = 331;
export const WEEK_TITLE_BLOB_READ_LIMIT = WEEK_JSON_BYTE_LIMIT + 4;

export interface WeekFixedFacet {
  startsAt: string;
  endsAt: string;
  contextDate: string;
}

export interface WeekDeadlineFacet {
  date: string;
}

export interface WeekTaskPlanningRecord {
  kind: "task";
  id: number;
  title: string;
  titleTruncated: boolean;
  status: "open" | "done";
  fixed: WeekFixedFacet | null;
  deadline: WeekDeadlineFacet | null;
}

export interface WeekGoalPlanningRecord {
  kind: "goal";
  id: number;
  title: string;
  titleTruncated: boolean;
  status: "active";
  deadline: WeekDeadlineFacet;
}

export interface WeekTrackedRecord {
  kind: "tracked";
  id: number;
  taskId: number;
  taskStatus: "open" | "done" | "archived";
  title: string;
  titleTruncated: boolean;
  startedAt: string;
  effectiveEndAt: string;
  running: boolean;
}

export type WeekRecord =
  | WeekTaskPlanningRecord
  | WeekGoalPlanningRecord
  | WeekTrackedRecord;

export interface WeekResponse {
  weekStart: string;
  timezone: string;
  requestNow: string;
  records: WeekRecord[];
  nextCursor: string | null;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveSafeId(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

export function isCanonicalWeekDate(value: unknown): value is string {
  if (typeof value !== "string" || !DATE_RE.test(value) || value.startsWith("0000")) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function isCanonicalWeekInstant(value: unknown): value is string {
  if (typeof value !== "string" || !INSTANT_RE.test(value)) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.getUTCFullYear() >= 1 && parsed.getUTCFullYear() <= 9999
    && parsed.toISOString() === value;
}

function validFixed(value: unknown): value is WeekFixedFacet {
  return object(value)
    && exactKeys(value, ["startsAt", "endsAt", "contextDate"])
    && isCanonicalWeekInstant(value.startsAt)
    && isCanonicalWeekInstant(value.endsAt)
    && value.endsAt > value.startsAt
    && isCanonicalWeekDate(value.contextDate);
}

function validDeadline(value: unknown): value is WeekDeadlineFacet {
  return object(value)
    && exactKeys(value, ["date"])
    && isCanonicalWeekDate(value.date);
}

function validRecord(value: unknown): value is WeekRecord {
  if (!object(value) || typeof value.kind !== "string") return false;
  if (value.kind === "task") {
    return exactKeys(value, ["kind", "id", "title", "titleTruncated", "status", "fixed", "deadline"])
      && positiveSafeId(value.id)
      && typeof value.title === "string"
      && typeof value.titleTruncated === "boolean"
      && (value.status === "open" || value.status === "done")
      && (value.fixed === null || validFixed(value.fixed))
      && (value.deadline === null || validDeadline(value.deadline))
      && (value.fixed !== null || value.deadline !== null);
  }
  if (value.kind === "goal") {
    return exactKeys(value, ["kind", "id", "title", "titleTruncated", "status", "deadline"])
      && positiveSafeId(value.id)
      && typeof value.title === "string"
      && typeof value.titleTruncated === "boolean"
      && value.status === "active"
      && validDeadline(value.deadline);
  }
  if (value.kind === "tracked") {
    return exactKeys(value, ["kind", "id", "taskId", "taskStatus", "title", "titleTruncated", "startedAt", "effectiveEndAt", "running"])
      && positiveSafeId(value.id)
      && positiveSafeId(value.taskId)
      && (value.taskStatus === "open" || value.taskStatus === "done" || value.taskStatus === "archived")
      && typeof value.title === "string"
      && typeof value.titleTruncated === "boolean"
      && isCanonicalWeekInstant(value.startedAt)
      && isCanonicalWeekInstant(value.effectiveEndAt)
      && value.effectiveEndAt > value.startedAt
      && typeof value.running === "boolean";
  }
  return false;
}

/** Closed runtime decoder shared by the API and the Phase 2B client.
 * The caller supplies the one frozen-registry predicate, keeping this wire
 * module dependency-free for browser, Node ESM and Playwright module loaders. */
export function decodeWeekResponse(
  value: unknown,
  isSupportedScheduleTimezone: (value: string) => boolean,
): WeekResponse {
  if (!object(value)
    || !exactKeys(value, ["weekStart", "timezone", "requestNow", "records", "nextCursor"])
    || !isCanonicalWeekDate(value.weekStart)
    || typeof value.timezone !== "string"
    || !isSupportedScheduleTimezone(value.timezone)
    || !isCanonicalWeekInstant(value.requestNow)
    || !Array.isArray(value.records)
    || value.records.length > WEEK_PAGE_RECORD_LIMIT
    || !value.records.every(validRecord)
    || !(value.nextCursor === null
      || (typeof value.nextCursor === "string"
        && value.nextCursor.length > 0
        && value.nextCursor.length <= WEEK_CURSOR_CHARACTER_LIMIT
        && /^[A-Za-z0-9_-]+$/.test(value.nextCursor)))) {
    throw new Error("invalid Week response");
  }
  return value as unknown as WeekResponse;
}
