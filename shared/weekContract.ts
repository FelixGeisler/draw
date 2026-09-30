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

function decodeTask(value: unknown): TaskPlanningRecord {
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
    fixed = { startsAt, endsAt, contextDate };
  }
  let deadline: TaskPlanningRecord["deadline"] = null;
  if (row.deadline !== null) {
    const part = object(row.deadline, ["date"], "task deadline");
    deadline = { date: date(part.date, "task deadline date") };
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

function decodeGoal(value: unknown): GoalPlanningRecord {
  const row = object(
    value,
    ["kind", "id", "title", "titleTruncated", "status", "deadline"],
    "goal record",
  );
  if (row.kind !== "goal" || row.status !== "active") throw new Error("goal discriminator is invalid");
  const deadline = object(row.deadline, ["date"], "goal deadline");
  return {
    kind: "goal",
    id: id(row.id, "goal id"),
    title: string(row.title, "goal title"),
    titleTruncated: bool(row.titleTruncated, "goal titleTruncated"),
    status: "active",
    deadline: { date: date(deadline.date, "goal deadline date") },
  };
}

function decodeTracked(value: unknown, requestNow: string): TrackedRecord {
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

/** Strict closed-union decoder shared by the server and the Phase 2B client. */
export function decodeWeekResponse(value: unknown): WeekResponse {
  const envelope = object(
    value,
    ["weekStart", "timezone", "requestNow", "records", "nextCursor"],
    "Week response",
  );
  const weekStart = date(envelope.weekStart, "weekStart");
  const timezone = string(envelope.timezone, "timezone");
  const requestNow = instant(envelope.requestNow, "requestNow");
  if (!Array.isArray(envelope.records) || envelope.records.length > WEEK_PAGE_SIZE) {
    throw new Error("records must be an array of at most 100 records");
  }
  const records = envelope.records.map((row) => {
    if (typeof row !== "object" || row === null || Array.isArray(row)) {
      throw new Error("record must be an object");
    }
    const kind = (row as Record<string, unknown>).kind;
    if (kind === "task") return decodeTask(row);
    if (kind === "goal") return decodeGoal(row);
    if (kind === "tracked") return decodeTracked(row, requestNow);
    throw new Error("record kind is invalid");
  });
  const identities = new Set<string>();
  for (const record of records) {
    const identity = `${record.kind}:${record.id}`;
    if (identities.has(identity)) throw new Error("record identity is duplicated");
    identities.add(identity);
  }
  if (envelope.nextCursor !== null && typeof envelope.nextCursor !== "string") {
    throw new Error("nextCursor must be a string or null");
  }
  return { weekStart, timezone, requestNow, records, nextCursor: envelope.nextCursor as string | null };
}

export function parseWeekResponseJson(json: string): WeekResponse {
  return decodeWeekResponse(JSON.parse(json) as unknown);
}
