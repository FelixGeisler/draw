export const WEEK_PAGE_SIZE = 100;
export const WEEK_BODY_MAX_BYTES = 131_072;
export const WEEK_CURSOR_RESERVE_CHARS = 375;

export type WeekResponse = {
  weekStart: string;
  timezone: string;
  requestNow: string;
  records: WeekRecord[];
  nextCursor: string | null;
};

export type WeekRecord = TaskPlanningRecord | GoalPlanningRecord | TrackedRecord;

export type TaskPlanningRecord = {
  kind: "task";
  id: number;
  title: string;
  titleTruncated: boolean;
  status: "open" | "done";
  fixed: null | { startsAt: string; endsAt: string; contextDate: string | null };
  deadline: null | { date: string };
};

export type GoalPlanningRecord = {
  kind: "goal";
  id: number;
  title: string;
  titleTruncated: boolean;
  status: "active";
  deadline: { date: string };
};

export type TrackedRecord = {
  kind: "tracked";
  id: number;
  taskId: number;
  taskStatus: "open" | "done" | "archived";
  title: string;
  titleTruncated: boolean;
  startedAt: string;
  effectiveEndAt: string;
  running: boolean;
};

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const CURSOR_KEYS = ["v", "w", "z", "n", "a", "k", "i"] as const;

/** Resolved request context supplied by the server and, later, the Week client. */
export type WeekValidationContext = Readonly<{
  weekStart: string;
  timezone: string;
  dates: readonly [string, string, string, string, string, string, string];
  midnightInstants: readonly [string, string, string, string, string, string, string, string];
  rangeStart: string;
  rangeEnd: string;
}>;

type InspectedCursor = Readonly<{
  requestNow: string;
  anchor: string;
  kindRank: 0 | 1 | 2;
  id: number;
}>;

function canonicalBase64urlDecode(value: string, maxChars: number, maxBytes: number): Uint8Array {
  if (value.length < 1 || value.length > maxChars || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error("cursor segment is not canonical base64url");
  }
  const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - value.length % 4) % 4);
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    throw new Error("cursor segment is not decodable base64url");
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (bytes.length > maxBytes) throw new Error("cursor segment is too large");
  const roundTrip = btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  if (roundTrip !== value) throw new Error("cursor segment has noncanonical trailing bits");
  return bytes;
}

/**
 * Browser-safe cursor inspection. It validates the closed envelope and payload
 * binding but deliberately does not claim to authenticate the HMAC tag.
 */
export function inspectWeekCursor(cursor: unknown, context: WeekValidationContext): InspectedCursor {
  if (typeof cursor !== "string" || cursor.length < 3 || cursor.length > WEEK_CURSOR_RESERVE_CHARS ||
      !/^[\x00-\x7f]+$/.test(cursor)) {
    throw new Error("nextCursor is not a bounded ASCII cursor");
  }
  const dot = cursor.indexOf(".");
  if (dot <= 0 || dot !== cursor.lastIndexOf(".")) throw new Error("nextCursor envelope is invalid");
  const payloadBytes = canonicalBase64urlDecode(cursor.slice(0, dot), 331, 248);
  const tagBytes = canonicalBase64urlDecode(cursor.slice(dot + 1), 43, 32);
  if (tagBytes.length !== 32 || cursor.slice(dot + 1).length !== 43) {
    throw new Error("nextCursor tag shape is invalid");
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(payloadBytes);
  } catch {
    throw new Error("nextCursor payload is not UTF-8");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error("nextCursor payload is not JSON");
  }
  const payload = object(parsed, CURSOR_KEYS, "nextCursor payload");
  const keys = Object.keys(payload);
  if (keys.some((key, index) => key !== CURSOR_KEYS[index]) || payload.v !== 2 ||
      payload.w !== context.weekStart || payload.z !== context.timezone ||
      !isCanonicalInstant(payload.n) || !isCanonicalInstant(payload.a) ||
      !Number.isInteger(payload.k) || ![0, 1, 2].includes(payload.k as number) ||
      !Number.isSafeInteger(payload.i) || (payload.i as number) <= 0) {
    throw new Error("nextCursor payload is invalid or mismatched");
  }
  if (new TextEncoder().encode(JSON.stringify(payload)).length !== payloadBytes.length ||
      JSON.stringify(payload) !== text) {
    throw new Error("nextCursor payload is noncanonical");
  }
  const anchorMs = Date.parse(payload.a as string);
  if (anchorMs < Date.parse(context.rangeStart) || anchorMs >= Date.parse(context.rangeEnd)) {
    throw new Error("nextCursor anchor is outside the Week");
  }
  return {
    requestNow: payload.n as string,
    anchor: payload.a as string,
    kindRank: payload.k as 0 | 1 | 2,
    id: payload.i as number,
  };
}

function object(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} has a missing or additional key`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  return value;
}

function bool(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
  return value;
}

function id(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value as number;
}

export function isCanonicalDate(value: unknown): value is string {
  if (typeof value !== "string" || !DATE.test(value)) return false;
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}

export function isCanonicalInstant(value: unknown): value is string {
  if (typeof value !== "string" || !INSTANT.test(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function date(value: unknown, label: string): string {
  if (!isCanonicalDate(value)) throw new Error(`${label} must be a canonical four-digit date`);
  return value;
}

function instant(value: unknown, label: string): string {
  if (!isCanonicalInstant(value)) throw new Error(`${label} must be a canonical four-digit instant`);
  return value;
}

const localDateFormatters = new Map<string, Intl.DateTimeFormat>();
function localDateForInstant(value: string, timezone: string): string | null {
  let formatter = localDateFormatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA-u-ca-gregory-nu-latn", {
      timeZone: timezone,
      calendar: "gregory",
      numberingSystem: "latn",
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    localDateFormatters.set(timezone, formatter);
  }
  const source = new Date(value);
  const parts = new Map(formatter.formatToParts(source).map((part) => [part.type, part.value]));
  const year = Number(parts.get("year"));
  const month = Number(parts.get("month"));
  const day = Number(parts.get("day"));
  if (source.getUTCFullYear() === 1 && source.getUTCMonth() === 0 && month === 12) return null;
  if (source.getUTCFullYear() === 9999 && source.getUTCMonth() === 11 && month === 1) return null;
  if (!Number.isInteger(year) || year < 1 || year > 9999 ||
      !Number.isInteger(month) || month < 1 || month > 12 ||
      !Number.isInteger(day) || day < 1 || day > 31) return null;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function addUtcDate(value: string, days: number): string | null {
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(Number(value.slice(0, 4)), Number(value.slice(5, 7)) - 1, Number(value.slice(8, 10)));
  date.setUTCDate(date.getUTCDate() + days);
  const year = date.getUTCFullYear();
  if (year < 1 || year > 9999) return null;
  return `${String(year).padStart(4, "0")}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

function validateContext(context: WeekValidationContext, scheduleTimeZones: ReadonlySet<string>): void {
  if (!isCanonicalDate(context.weekStart) || !scheduleTimeZones.has(context.timezone) ||
      context.dates.length !== 7 || context.midnightInstants.length !== 8 ||
      context.dates.some((value, index) => value !== addUtcDate(context.weekStart, index)) ||
      context.rangeStart !== context.midnightInstants[0] || context.rangeEnd !== context.midnightInstants[7] ||
      context.midnightInstants.some((value) => !isCanonicalInstant(value)) ||
      context.midnightInstants.some((value, index) => index > 0 && Date.parse(value) <= Date.parse(context.midnightInstants[index - 1]))) {
    throw new Error("Week validation context is invalid");
  }
  const monday = new Date(`${context.weekStart}T00:00:00.000Z`);
  if (monday.getUTCDay() !== 1) throw new Error("Week validation context does not start Monday");
}

function decodeTask(value: unknown, context: WeekValidationContext): TaskPlanningRecord {
  const row = object(
    value,
    ["kind", "id", "title", "titleTruncated", "status", "fixed", "deadline"],
    "task record",
  );
  if (row.kind !== "task") throw new Error("task record kind is invalid");
  if (row.status !== "open" && row.status !== "done") throw new Error("task status is invalid");
  let fixed: TaskPlanningRecord["fixed"] = null;
  if (row.fixed !== null) {
    const part = object(row.fixed, ["startsAt", "endsAt", "contextDate"], "fixed facet");
    const startsAt = instant(part.startsAt, "fixed startsAt");
    const endsAt = instant(part.endsAt, "fixed endsAt");
    if (Date.parse(endsAt) <= Date.parse(startsAt)) throw new Error("fixed interval is empty");
    const contextDate = part.contextDate === null ? null : date(part.contextDate, "fixed contextDate");
    const expectedContextDate = localDateForInstant(startsAt, context.timezone);
    if (contextDate !== expectedContextDate) throw new Error("fixed contextDate does not match startsAt in the Week timezone");
    if (Date.parse(startsAt) >= Date.parse(context.rangeEnd) || Date.parse(endsAt) <= Date.parse(context.rangeStart)) {
      throw new Error("fixed interval does not overlap the Week");
    }
    fixed = { startsAt, endsAt, contextDate };
  }
  let deadline: TaskPlanningRecord["deadline"] = null;
  if (row.deadline !== null) {
    const part = object(row.deadline, ["date"], "task deadline");
    deadline = { date: date(part.date, "task deadline date") };
    if (!context.dates.includes(deadline.date)) throw new Error("task deadline is outside the Week");
  }
  if (fixed === null && deadline === null) throw new Error("task record has no visible facet");
  if (row.status === "done" && deadline !== null) throw new Error("done task exposes a deadline");
  return {
    kind: "task",
    id: id(row.id, "task id"),
    title: string(row.title, "task title"),
    titleTruncated: bool(row.titleTruncated, "task titleTruncated"),
    status: row.status,
    fixed,
    deadline,
  };
}

function decodeGoal(value: unknown, context: WeekValidationContext): GoalPlanningRecord {
  const row = object(
    value,
    ["kind", "id", "title", "titleTruncated", "status", "deadline"],
    "goal record",
  );
  if (row.kind !== "goal" || row.status !== "active") throw new Error("goal discriminator is invalid");
  const deadline = object(row.deadline, ["date"], "goal deadline");
  const deadlineDate = date(deadline.date, "goal deadline date");
  if (!context.dates.includes(deadlineDate)) throw new Error("goal deadline is outside the Week");
  return {
    kind: "goal",
    id: id(row.id, "goal id"),
    title: string(row.title, "goal title"),
    titleTruncated: bool(row.titleTruncated, "goal titleTruncated"),
    status: "active",
    deadline: { date: deadlineDate },
  };
}

function decodeTracked(value: unknown, requestNow: string, context: WeekValidationContext): TrackedRecord {
  const row = object(
    value,
    [
      "kind", "id", "taskId", "taskStatus", "title", "titleTruncated",
      "startedAt", "effectiveEndAt", "running",
    ],
    "tracked record",
  );
  if (row.kind !== "tracked") throw new Error("tracked record kind is invalid");
  if (row.taskStatus !== "open" && row.taskStatus !== "done" && row.taskStatus !== "archived") {
    throw new Error("tracked taskStatus is invalid");
  }
  const startedAt = instant(row.startedAt, "tracked startedAt");
  const effectiveEndAt = instant(row.effectiveEndAt, "tracked effectiveEndAt");
  const running = bool(row.running, "tracked running");
  if (Date.parse(effectiveEndAt) <= Date.parse(startedAt)) throw new Error("tracked interval is empty");
  if (running && effectiveEndAt !== requestNow) throw new Error("running tracked interval is not bound to requestNow");
  if (Date.parse(startedAt) >= Date.parse(context.rangeEnd) ||
      Date.parse(effectiveEndAt) <= Date.parse(context.rangeStart)) {
    throw new Error("tracked interval does not overlap the Week");
  }
  return {
    kind: "tracked",
    id: id(row.id, "tracked id"),
    taskId: id(row.taskId, "tracked taskId"),
    taskStatus: row.taskStatus,
    title: string(row.title, "tracked title"),
    titleTruncated: bool(row.titleTruncated, "tracked titleTruncated"),
    startedAt,
    effectiveEndAt,
    running,
  };
}

function visibleTuple(
  record: WeekRecord,
  context: WeekValidationContext,
): readonly [number, 0 | 1 | 2, number] {
  const rangeStart = Date.parse(context.rangeStart);
  if (record.kind === "tracked") {
    return [Math.max(Date.parse(record.startedAt), rangeStart), 2, record.id];
  }
  if (record.kind === "goal") {
    return [Date.parse(context.midnightInstants[context.dates.indexOf(record.deadline.date)]), 1, record.id];
  }
  const fixedAnchor = record.fixed ? Math.max(Date.parse(record.fixed.startsAt), rangeStart) : null;
  const deadlineAnchor = record.deadline
    ? Date.parse(context.midnightInstants[context.dates.indexOf(record.deadline.date)])
    : null;
  let anchor: number;
  if (fixedAnchor !== null && deadlineAnchor !== null) {
    anchor = record.fixed!.contextDate === record.deadline!.date
      ? fixedAnchor
      : Math.min(fixedAnchor, deadlineAnchor);
  } else {
    anchor = fixedAnchor ?? deadlineAnchor!;
  }
  return [anchor, 0, record.id];
}

function tupleAfter(
  current: readonly [number, number, number],
  previous: readonly [number, number, number],
): boolean {
  return current[0] > previous[0] ||
    (current[0] === previous[0] && current[1] > previous[1]) ||
    (current[0] === previous[0] && current[1] === previous[1] && current[2] > previous[2]);
}

/**
 * Contextual strict closed-union decoder shared by the final server gate and
 * the Phase 2B browser. Browser inspection validates cursor binding and shape;
 * only the server's cursor codec authenticates its MAC.
 */
export function decodeWeekResponse(
  value: unknown,
  context: WeekValidationContext,
  scheduleTimeZones: ReadonlySet<string>,
): WeekResponse {
  validateContext(context, scheduleTimeZones);
  const envelope = object(
    value,
    ["weekStart", "timezone", "requestNow", "records", "nextCursor"],
    "Week response",
  );
  const weekStart = date(envelope.weekStart, "weekStart");
  const timezone = string(envelope.timezone, "timezone");
  if (weekStart !== context.weekStart || timezone !== context.timezone) {
    throw new Error("Week response does not match the requested Week context");
  }
  const requestNow = instant(envelope.requestNow, "requestNow");
  if (!Array.isArray(envelope.records) || envelope.records.length > WEEK_PAGE_SIZE) {
    throw new Error("records must be an array of at most 100 records");
  }
  const records = envelope.records.map((row) => {
    if (typeof row !== "object" || row === null || Array.isArray(row)) {
      throw new Error("record must be an object");
    }
    const kind = (row as Record<string, unknown>).kind;
    if (kind === "task") return decodeTask(row, context);
    if (kind === "goal") return decodeGoal(row, context);
    if (kind === "tracked") return decodeTracked(row, requestNow, context);
    throw new Error("record kind is invalid");
  });
  const identities = new Set<string>();
  let previous: readonly [number, number, number] | null = null;
  let truncated = 0;
  for (const record of records) {
    const identity = `${record.kind}:${record.id}`;
    if (identities.has(identity)) throw new Error("record identity is duplicated");
    identities.add(identity);
    if (record.titleTruncated) truncated += 1;
    const tuple = visibleTuple(record, context);
    if (previous && !tupleAfter(tuple, previous)) throw new Error("records are not in canonical order");
    previous = tuple;
  }
  if (truncated > 0 && (truncated !== 1 || records.length !== 1)) {
    throw new Error("a truncated title must be the only record on its page");
  }
  if (envelope.nextCursor !== null && typeof envelope.nextCursor !== "string") {
    throw new Error("nextCursor must be a string or null");
  }
  const nextCursor = envelope.nextCursor as string | null;
  if (nextCursor !== null) {
    if (!previous) throw new Error("an empty page cannot carry a continuation cursor");
    const inspected = inspectWeekCursor(nextCursor, context);
    if (inspected.requestNow !== requestNow || inspected.anchor !== new Date(previous[0]).toISOString() ||
        inspected.kindRank !== previous[1] || inspected.id !== previous[2]) {
      throw new Error("nextCursor is not bound to the final emitted record");
    }
  }
  if (new TextEncoder().encode(JSON.stringify(value)).length > WEEK_BODY_MAX_BYTES) {
    throw new Error("Week response exceeds the final JSON byte bound");
  }
  return { weekStart, timezone, requestNow, records, nextCursor };
}

export function parseWeekResponseJson(
  json: string,
  context: WeekValidationContext,
  scheduleTimeZones: ReadonlySet<string>,
): WeekResponse {
  return decodeWeekResponse(JSON.parse(json) as unknown, context, scheduleTimeZones);
}
