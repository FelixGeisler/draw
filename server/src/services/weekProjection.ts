import { TextDecoder } from "node:util";
import type Database from "better-sqlite3";
import { db } from "../db.js";
import {
  WEEK_CURSOR_CHARACTER_LIMIT,
  WEEK_IDENTITY_LOOKAHEAD_LIMIT,
  WEEK_JSON_BYTE_LIMIT,
  WEEK_PAGE_RECORD_LIMIT,
  WEEK_TITLE_BLOB_READ_LIMIT,
  decodeWeekResponse,
  isCanonicalWeekInstant,
  type WeekRecord,
  type WeekResponse,
} from "../../../shared/weekContract.js";
import { addCalendarDays, createZonedFormatter, validCalendarDate, zonedMinute } from "./localDay.js";
import { isScheduleTimeZone, resolveWallMinute } from "./fixedSlots.js";

const SAFE_ID_MAX = 9_007_199_254_740_991;
const CURSOR_VERSION = 1;
const MAX_CURSOR_PLACEHOLDER = "A".repeat(WEEK_CURSOR_CHARACTER_LIMIT);
const utf8Fatal = new TextDecoder("utf-8", { fatal: true });

export class WeekRequestError extends Error {}

export interface WeekProjectionInstrumentation {
  identityCount?: (count: number) => void;
  titleRead?: (bytesRequested: number, kind: "task" | "goal" | "tracked", id: number) => void;
  canonicalParse?: (value: string) => void;
}

export interface WeekProjectionOptions {
  now?: () => Date;
  instrumentation?: WeekProjectionInstrumentation;
}

interface ResolvedWeek {
  weekStart: string;
  timezone: string;
  dates: string[];
  anchors: string[];
  rangeStart: string;
  rangeEnd: string;
}

interface WeekCursor {
  v: 1;
  w: string;
  z: string;
  n: string;
  a: string;
  k: 0 | 1 | 2;
  i: number;
}

interface WeekIdentity {
  anchor: string;
  rank: 0 | 1 | 2;
  id: number;
  status: "open" | "done" | "active" | "archived";
  fixedStartsAt: string | null;
  fixedEndsAt: string | null;
  contextDate: string | null;
  deadlineDate: string | null;
  taskId: number | null;
  startedAt: string | null;
  effectiveEndAt: string | null;
  running: 0 | 1;
}

interface StoredTitle {
  titleBlob: Buffer;
  titleBytes: number;
}

export interface ParsedWeekRequest {
  weekStart: string;
  timezone: string;
  cursor?: string;
}

function monday(value: string): boolean {
  if (!validCalendarDate(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  return date.getUTCDay() === 1;
}

export function parseWeekRequestQuery(query: Record<string, unknown>): ParsedWeekRequest {
  const keys = Object.keys(query).sort();
  const expected = query.cursor === undefined
    ? ["timezone", "weekStart"]
    : ["cursor", "timezone", "weekStart"];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new WeekRequestError("query must contain exactly weekStart, timezone and optional cursor");
  }
  const { weekStart, timezone, cursor } = query;
  if (typeof weekStart !== "string" || typeof timezone !== "string"
    || (cursor !== undefined && typeof cursor !== "string")) {
    throw new WeekRequestError("query values must be singular strings");
  }
  return { weekStart, timezone, ...(cursor === undefined ? {} : { cursor }) };
}

export function resolveWeek(weekStart: string, timezone: string): ResolvedWeek {
  if (!monday(weekStart) || !isScheduleTimeZone(timezone)) {
    throw new WeekRequestError("invalid Week or schedule timezone");
  }
  const dates: string[] = [];
  for (let offset = 0; offset < 7; offset++) {
    const date = addCalendarDays(weekStart, offset);
    if (date === null) throw new WeekRequestError("Week exceeds the four-digit calendar domain");
    dates.push(date);
  }
  const nextMonday = addCalendarDays(weekStart, 7);
  if (nextMonday === null) throw new WeekRequestError("Week exceeds the four-digit calendar domain");
  try {
    const anchors = dates.map((date) => resolveWallMinute(`${date}T00:00`, timezone, "week date").instant);
    const rangeStart = anchors[0];
    const rangeEnd = resolveWallMinute(`${nextMonday}T00:00`, timezone, "exclusive next Monday").instant;
    if (!isCanonicalWeekInstant(rangeStart) || !isCanonicalWeekInstant(rangeEnd) || rangeEnd <= rangeStart) {
      throw new Error("invalid resolved Week bounds");
    }
    return { weekStart, timezone, dates, anchors, rangeStart, rangeEnd };
  } catch (error) {
    if (error instanceof WeekRequestError) throw error;
    throw new WeekRequestError("Week bounds do not resolve inside the four-digit instant domain");
  }
}

export function encodeWeekCursor(cursor: WeekCursor): string {
  const json = JSON.stringify({
    v: cursor.v,
    w: cursor.w,
    z: cursor.z,
    n: cursor.n,
    a: cursor.a,
    k: cursor.k,
    i: cursor.i,
  });
  return Buffer.from(json, "utf8").toString("base64url");
}

function decodeWeekCursor(value: string, week: ResolvedWeek): WeekCursor {
  // Reject over-policy input before allocating a decoded buffer.
  if (value.length < 1 || value.length > WEEK_CURSOR_CHARACTER_LIMIT || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new WeekRequestError("invalid cursor encoding");
  }
  let bytes: Buffer;
  let json: string;
  try {
    bytes = Buffer.from(value, "base64url");
    if (bytes.toString("base64url") !== value) throw new Error("noncanonical base64url");
    json = utf8Fatal.decode(bytes);
  } catch {
    throw new WeekRequestError("invalid cursor encoding");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new WeekRequestError("invalid cursor JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new WeekRequestError("invalid cursor shape");
  }
  const cursor = parsed as Record<string, unknown>;
  const keys = Object.keys(cursor);
  const expected = ["v", "w", "z", "n", "a", "k", "i"];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])
    || cursor.v !== CURSOR_VERSION
    || cursor.w !== week.weekStart
    || cursor.z !== week.timezone
    || !isCanonicalWeekInstant(cursor.n)
    || !isCanonicalWeekInstant(cursor.a)
    || (cursor.k !== 0 && cursor.k !== 1 && cursor.k !== 2)
    || !Number.isSafeInteger(cursor.i) || (cursor.i as number) <= 0
    || cursor.a < week.rangeStart || cursor.a >= week.rangeEnd) {
    throw new WeekRequestError("invalid cursor value");
  }
  const result = cursor as unknown as WeekCursor;
  if (JSON.stringify(result) !== json || encodeWeekCursor(result) !== value) {
    throw new WeekRequestError("noncanonical cursor");
  }
  return result;
}

function canonicalStoredInstant(value: unknown, instrumentation?: WeekProjectionInstrumentation): number {
  // SQL reaches this function only through an exact type/byte-length CASE.
  if (typeof value !== "string") return 0;
  instrumentation?.canonicalParse?.(value);
  return isCanonicalWeekInstant(value) ? 1 : 0;
}

function registerProjectionFunctions(
  database: Database.Database,
  instrumentation?: WeekProjectionInstrumentation,
): void {
  database.function("week_is_canonical_instant", { deterministic: true }, (value: unknown) =>
    canonicalStoredInstant(value, instrumentation));
  database.function("week_local_date", { deterministic: true }, (value: unknown, timezone: unknown) => {
    if (typeof value !== "string" || typeof timezone !== "string" || !isCanonicalWeekInstant(value)) {
      throw new Error("invalid guarded Week local-date input");
    }
    return zonedMinute(createZonedFormatter(timezone), new Date(value)).date;
  });
}

const IDENTITY_SQL = `WITH
  week_dates(date,anchor) AS (VALUES
    (@d0,@a0),(@d1,@a1),(@d2,@a2),(@d3,@a3),(@d4,@a4),(@d5,@a5),(@d6,@a6)
  ),
  fixed_shaped AS MATERIALIZED (
    SELECT fs.task_id AS id,fs.starts_at AS starts_at,fs.ends_at AS ends_at
    FROM task_fixed_slots fs INDEXED BY idx_task_fixed_slots_range
    JOIN tasks t ON t.id=fs.task_id
    WHERE fs.starts_at < @rangeEnd
      AND fs.task_id BETWEEN 1 AND ${SAFE_ID_MAX}
      AND t.status IN ('open','done')
      AND typeof(fs.starts_at)='text'
      AND length(CAST(fs.starts_at AS BLOB))=24
      AND CASE WHEN typeof(fs.starts_at)='text' AND length(CAST(fs.starts_at AS BLOB))=24
        THEN week_is_canonical_instant(fs.starts_at) ELSE 0 END=1
      AND typeof(fs.ends_at)='text'
      AND length(CAST(fs.ends_at AS BLOB))=24
      AND CASE WHEN typeof(fs.ends_at)='text' AND length(CAST(fs.ends_at AS BLOB))=24
        THEN week_is_canonical_instant(fs.ends_at) ELSE 0 END=1
  ),
  valid_fixed AS MATERIALIZED (
    SELECT id,starts_at,ends_at,
      week_local_date(starts_at,@timezone) AS context_date,
      CASE WHEN starts_at < @rangeStart THEN @rangeStart ELSE starts_at END AS anchor
    FROM fixed_shaped
    WHERE ends_at > starts_at AND ends_at > @rangeStart
  ),
  task_deadlines AS MATERIALIZED (
    SELECT t.id,t.due_date AS date,wd.anchor
    FROM tasks t JOIN week_dates wd ON wd.date=t.due_date
    WHERE t.status='open' AND t.id BETWEEN 1 AND ${SAFE_ID_MAX}
  ),
  task_ids AS MATERIALIZED (
    SELECT id FROM valid_fixed UNION SELECT id FROM task_deadlines
  ),
  task_plans AS MATERIALIZED (
    SELECT
      CASE
        WHEN f.id IS NOT NULL AND d.id IS NOT NULL AND f.context_date=d.date THEN f.anchor
        WHEN d.anchor IS NULL OR (f.anchor IS NOT NULL AND f.anchor < d.anchor) THEN f.anchor
        ELSE d.anchor
      END AS anchor,
      0 AS rank,t.id,t.status,
      f.starts_at AS fixedStartsAt,f.ends_at AS fixedEndsAt,f.context_date AS contextDate,
      d.date AS deadlineDate,
      NULL AS taskId,NULL AS startedAt,NULL AS effectiveEndAt,0 AS running
    FROM task_ids x JOIN tasks t ON t.id=x.id
    LEFT JOIN valid_fixed f ON f.id=x.id
    LEFT JOIN task_deadlines d ON d.id=x.id
  ),
  goal_plans AS MATERIALIZED (
    SELECT wd.anchor AS anchor,1 AS rank,g.id,g.status,
      NULL AS fixedStartsAt,NULL AS fixedEndsAt,NULL AS contextDate,g.target_date AS deadlineDate,
      NULL AS taskId,NULL AS startedAt,NULL AS effectiveEndAt,0 AS running
    FROM goals g JOIN week_dates wd ON wd.date=g.target_date
    WHERE g.status='active' AND g.id BETWEEN 1 AND ${SAFE_ID_MAX}
  ),
  tracked_shaped AS MATERIALIZED (
    SELECT e.id,e.task_id,e.started_at,e.ended_at,t.status
    FROM time_entries e INDEXED BY idx_time_entries_range
    JOIN tasks t ON t.id=e.task_id
    WHERE e.started_at < @rangeEnd
      AND e.id BETWEEN 1 AND ${SAFE_ID_MAX}
      AND e.task_id BETWEEN 1 AND ${SAFE_ID_MAX}
      AND t.status IN ('open','done','archived')
      AND typeof(e.started_at)='text'
      AND length(CAST(e.started_at AS BLOB))=24
      AND CASE WHEN typeof(e.started_at)='text' AND length(CAST(e.started_at AS BLOB))=24
        THEN week_is_canonical_instant(e.started_at) ELSE 0 END=1
      AND CASE
        WHEN e.ended_at IS NULL THEN 1
        WHEN typeof(e.ended_at)='text' AND length(CAST(e.ended_at AS BLOB))=24
          THEN week_is_canonical_instant(e.ended_at)
        ELSE 0
      END=1
  ),
  tracked AS MATERIALIZED (
    SELECT CASE WHEN started_at < @rangeStart THEN @rangeStart ELSE started_at END AS anchor,
      2 AS rank,id,status,
      NULL AS fixedStartsAt,NULL AS fixedEndsAt,NULL AS contextDate,NULL AS deadlineDate,
      task_id AS taskId,started_at AS startedAt,
      CASE WHEN ended_at IS NULL THEN @requestNow ELSE ended_at END AS effectiveEndAt,
      CASE WHEN ended_at IS NULL THEN 1 ELSE 0 END AS running
    FROM tracked_shaped
    WHERE (ended_at IS NULL
        AND @requestNow > started_at
        AND @requestNow > @rangeStart)
      OR (ended_at IS NOT NULL
        AND ended_at > started_at
        AND ended_at > @rangeStart)
  ),
  identities AS MATERIALIZED (
    SELECT * FROM task_plans
    UNION ALL SELECT * FROM goal_plans
    UNION ALL SELECT * FROM tracked
  )
SELECT anchor,rank,id,status,fixedStartsAt,fixedEndsAt,contextDate,deadlineDate,
       taskId,startedAt,effectiveEndAt,running
FROM identities
WHERE @afterAnchor IS NULL
   OR anchor > @afterAnchor
   OR (anchor=@afterAnchor AND rank > @afterRank)
   OR (anchor=@afterAnchor AND rank=@afterRank AND id > @afterId)
ORDER BY anchor ASC,rank ASC,id ASC
LIMIT ${WEEK_IDENTITY_LOOKAHEAD_LIMIT}`;

function selectIdentities(
  database: Database.Database,
  week: ResolvedWeek,
  requestNow: string,
  cursor: WeekCursor | null,
  instrumentation?: WeekProjectionInstrumentation,
): WeekIdentity[] {
  registerProjectionFunctions(database, instrumentation);
  const params: Record<string, string | number | null> = {
    timezone: week.timezone,
    rangeStart: week.rangeStart,
    rangeEnd: week.rangeEnd,
    requestNow,
    afterAnchor: cursor?.a ?? null,
    afterRank: cursor?.k ?? -1,
    afterId: cursor?.i ?? 0,
  };
  for (let index = 0; index < 7; index++) {
    params[`d${index}`] = week.dates[index];
    params[`a${index}`] = week.anchors[index];
  }
  const rows = database.prepare(IDENTITY_SQL).all(params) as WeekIdentity[];
  instrumentation?.identityCount?.(rows.length);
  return rows;
}

function identityKind(identity: WeekIdentity): "task" | "goal" | "tracked" {
  return identity.rank === 0 ? "task" : identity.rank === 1 ? "goal" : "tracked";
}

function readTitle(
  database: Database.Database,
  identity: WeekIdentity,
  instrumentation?: WeekProjectionInstrumentation,
): StoredTitle {
  const kind = identityKind(identity);
  const table = kind === "goal" ? "goals" : "tasks";
  const sourceId = kind === "tracked" ? identity.taskId : identity.id;
  if (!Number.isSafeInteger(sourceId) || (sourceId as number) <= 0) throw new Error("invalid title source");
  instrumentation?.titleRead?.(WEEK_TITLE_BLOB_READ_LIMIT, kind, identity.id);
  const row = database.prepare(
    `SELECT CAST(substr(CAST(title AS BLOB),1,?) AS BLOB) AS titleBlob,
            length(CAST(title AS BLOB)) AS titleBytes
     FROM ${table}
     WHERE id=? AND typeof(title)='text'`,
  ).get(WEEK_TITLE_BLOB_READ_LIMIT, sourceId) as
    | { titleBlob: Buffer | null; titleBytes: number }
    | undefined;
  if (!row || !Number.isSafeInteger(row.titleBytes) || row.titleBytes < 0
    || !(Buffer.isBuffer(row.titleBlob) || (row.titleBlob === null && row.titleBytes === 0))) {
    throw new Error("invalid title source");
  }
  return { titleBlob: row.titleBlob ?? Buffer.alloc(0), titleBytes: row.titleBytes };
}

function decodeUtf8Prefix(buffer: Buffer): string {
  for (let removed = 0; removed <= 3 && removed <= buffer.length; removed++) {
    try {
      return utf8Fatal.decode(buffer.subarray(0, buffer.length - removed));
    } catch {
      // A valid UTF-8 source can have at most three continuation bytes at a
      // bounded cut. Any earlier malformed sequence remains an invariant fault.
    }
  }
  throw new Error("stored title is not valid UTF-8");
}

function recordWithTitle(identity: WeekIdentity, title: string, titleTruncated: boolean): WeekRecord {
  if (identity.rank === 0) {
    if ((identity.status !== "open" && identity.status !== "done")
      || ((identity.fixedStartsAt === null || identity.fixedEndsAt === null || identity.contextDate === null)
        && identity.deadlineDate === null)) throw new Error("invalid task planning identity");
    return {
      kind: "task",
      id: identity.id,
      title,
      titleTruncated,
      status: identity.status,
      fixed: identity.fixedStartsAt === null || identity.fixedEndsAt === null || identity.contextDate === null
        ? null
        : { startsAt: identity.fixedStartsAt, endsAt: identity.fixedEndsAt, contextDate: identity.contextDate },
      deadline: identity.deadlineDate === null ? null : { date: identity.deadlineDate },
    };
  }
  if (identity.rank === 1) {
    if (identity.status !== "active" || identity.deadlineDate === null) throw new Error("invalid goal identity");
    return {
      kind: "goal",
      id: identity.id,
      title,
      titleTruncated,
      status: "active",
      deadline: { date: identity.deadlineDate },
    };
  }
  if ((identity.status !== "open" && identity.status !== "done" && identity.status !== "archived")
    || identity.taskId === null || identity.startedAt === null || identity.effectiveEndAt === null) {
    throw new Error("invalid tracked identity");
  }
  return {
    kind: "tracked",
    id: identity.id,
    taskId: identity.taskId,
    taskStatus: identity.status,
    title,
    titleTruncated,
    startedAt: identity.startedAt,
    effectiveEndAt: identity.effectiveEndAt,
    running: identity.running === 1,
  };
}

function responseBytes(
  week: ResolvedWeek,
  requestNow: string,
  records: WeekRecord[],
  nextCursor: string | null,
): number {
  return Buffer.byteLength(JSON.stringify({
    weekStart: week.weekStart,
    timezone: week.timezone,
    requestNow,
    records,
    nextCursor,
  }), "utf8");
}

function truncateOversizedTitle(
  week: ResolvedWeek,
  requestNow: string,
  identity: WeekIdentity,
  availablePrefix: string,
  reservedCursor: string | null,
): WeekRecord {
  const codePoints = Array.from(availablePrefix);
  const empty = recordWithTitle(identity, "", true);
  if (responseBytes(week, requestNow, [empty], reservedCursor) > WEEK_JSON_BYTE_LIMIT) {
    throw new Error("Week record structure exceeds response budget");
  }
  let low = 0;
  let high = codePoints.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = recordWithTitle(identity, codePoints.slice(0, middle).join(""), true);
    if (responseBytes(week, requestNow, [candidate], reservedCursor) <= WEEK_JSON_BYTE_LIMIT) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return recordWithTitle(identity, codePoints.slice(0, low).join(""), true);
}

function cursorFor(week: ResolvedWeek, requestNow: string, identity: WeekIdentity): string {
  const cursor = encodeWeekCursor({
    v: 1,
    w: week.weekStart,
    z: week.timezone,
    n: requestNow,
    a: identity.anchor,
    k: identity.rank,
    i: identity.id,
  });
  if (cursor.length > WEEK_CURSOR_CHARACTER_LIMIT) throw new Error("generated cursor exceeds policy");
  return cursor;
}

export function projectWeek(
  input: ParsedWeekRequest,
  database: Database.Database = db,
  options: WeekProjectionOptions = {},
): WeekResponse {
  const week = resolveWeek(input.weekStart, input.timezone);
  const cursor = input.cursor === undefined ? null : decodeWeekCursor(input.cursor, week);
  const requestNow = cursor?.n ?? options.now?.().toISOString() ?? new Date().toISOString();
  if (!isCanonicalWeekInstant(requestNow)) throw new Error("request clock is outside the Week instant contract");

  const identities = selectIdentities(database, week, requestNow, cursor, options.instrumentation);
  const records: WeekRecord[] = [];
  let lastIdentity: WeekIdentity | null = null;

  for (let index = 0; index < identities.length && records.length < WEEK_PAGE_RECORD_LIMIT; index++) {
    const identity = identities[index];
    const stored = readTitle(database, identity, options.instrumentation);
    const prefix = decodeUtf8Prefix(stored.titleBlob);
    const titleComplete = stored.titleBytes <= stored.titleBlob.length;
    const intact = titleComplete ? recordWithTitle(identity, prefix, false) : null;

    // Once the bounded look-ahead proves this identity is the final result,
    // `null` is fixed and there is no possible continuation to reserve.
    const reservedCursor = index === identities.length - 1
      && identities.length < WEEK_IDENTITY_LOOKAHEAD_LIMIT
      ? null
      : MAX_CURSOR_PLACEHOLDER;
    let record: WeekRecord;
    if (intact !== null
      && responseBytes(week, requestNow, [intact], reservedCursor) <= WEEK_JSON_BYTE_LIMIT) {
      if (responseBytes(week, requestNow, [...records, intact], reservedCursor) > WEEK_JSON_BYTE_LIMIT) {
        // It fits an empty page, so page-position must not alter its title.
        break;
      }
      record = intact;
    } else {
      // Only a record that cannot fit alone intact may be truncated.
      record = truncateOversizedTitle(week, requestNow, identity, prefix, reservedCursor);
      if (records.length > 0) break;
    }
    records.push(record);
    lastIdentity = identity;
  }

  if (identities.length > 0 && records.length === 0) {
    throw new Error("valid Week candidate produced an empty page");
  }
  const hasMore = lastIdentity !== null
    && (records.length < identities.length || identities.length === WEEK_IDENTITY_LOOKAHEAD_LIMIT);
  const nextCursor = hasMore ? cursorFor(week, requestNow, lastIdentity!) : null;
  const response: WeekResponse = {
    weekStart: week.weekStart,
    timezone: week.timezone,
    requestNow,
    records,
    nextCursor,
  };
  if (Buffer.byteLength(JSON.stringify(response), "utf8") > WEEK_JSON_BYTE_LIMIT) {
    throw new Error("Week response exceeds byte budget");
  }
  // Re-read our own exact wire through the shared closed decoder before it can
  // cross the HTTP boundary. Any source/invariant fault therefore becomes one
  // closed 500 rather than a partial projection.
  return decodeWeekResponse(response, isScheduleTimeZone);
}
