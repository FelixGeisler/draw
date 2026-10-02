import Database from "better-sqlite3";
import { parentPort, workerData } from "node:worker_threads";
import {
  WEEK_BODY_MAX_BYTES,
  WEEK_CURSOR_RESERVE_CHARS,
  WEEK_PAGE_SIZE,
  type GoalPlanningRecord,
  type TaskPlanningRecord,
  type TrackedRecord,
  type WeekRecord,
} from "../../shared/weekContract.js";
import { contextDateForInstant } from "./weekTime.js";
import { WEEK_IDENTITY_SQL as WEEK_QUERY_SQL } from "./weekQuery.js";
import type {
  WeekWorkerClose,
  WeekWorkerFailure,
  WeekWorkerMessage,
  WeekWorkerRequest,
  WeekWorkerResult,
} from "./weekWorkerProtocol.js";

const channel = parentPort;
if (!channel) throw new Error("Week worker requires a parent port");
const bootstrap = workerData as { databasePath?: unknown };
if (typeof bootstrap.databasePath !== "string" || bootstrap.databasePath.length === 0) {
  throw new Error("Week worker database bootstrap is invalid");
}

const database = new Database(bootstrap.databasePath, { readonly: true, fileMustExist: true });
database.unsafeMode(false);
database.pragma("trusted_schema = OFF");
database.pragma("query_only = ON");
database.pragma("cache_size = -2048");
database.pragma("temp_store = FILE");

class ProjectionError extends Error {
  constructor(
    readonly code: "unavailable" | "failed",
    readonly discard: boolean,
  ) {
    super(code);
  }
}

function unavailable(): never {
  throw new ProjectionError("unavailable", false);
}
function failed(): never {
  throw new ProjectionError("failed", true);
}
function identityQueryFailure(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  if (/no such (?:table|index|module)|malformed|not a database|database disk image is malformed/i.test(message)) {
    unavailable();
  }
  failed();
}

type IdentityRow = {
  recordKind: "task" | "goal" | "tracked";
  sourceId: unknown;
  taskId: unknown;
  kindRank: unknown;
  visibleAnchor: unknown;
  sourceStatus: unknown;
  fixedStart: unknown;
  fixedEnd: unknown;
  deadlineDate: unknown;
  trackedStart: unknown;
  trackedEnd: unknown;
  companionStart: unknown;
  companionEnd: unknown;
};

type TitleRow = { storageType: unknown; byteLength: unknown; prefix: unknown };
const titleStatements = {
  task: database.prepare(`SELECT typeof(title) AS storageType,octet_length(title) AS byteLength,
    substr(CAST(title AS BLOB),1,?) AS prefix FROM tasks WHERE id=?`),
  goal: database.prepare(`SELECT typeof(title) AS storageType,octet_length(title) AS byteLength,
    substr(CAST(title AS BLOB),1,?) AS prefix FROM goals WHERE id=?`),
  tracked: database.prepare(`SELECT typeof(title) AS storageType,octet_length(title) AS byteLength,
    substr(CAST(title AS BLOB),1,?) AS prefix FROM tasks WHERE id=?`),
};

function positiveId(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) failed();
  return value as number;
}

function canonicalInstant(value: unknown): { text: string; ms: number } {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    failed();
  }
  const year = Number((value as string).slice(0, 4));
  const ms = Date.parse(value as string);
  if (year < 1 || year > 9999 || !Number.isSafeInteger(ms) ||
      new Date(ms).getUTCFullYear() < 1 || new Date(ms).getUTCFullYear() > 9999 ||
      new Date(ms).toISOString() !== value) failed();
  return { text: value as string, ms };
}

function sourceInstant(value: unknown): { text: string; ms: number } {
  try {
    return canonicalInstant(value);
  } catch {
    unavailable();
  }
}

function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    failed();
  }
}

function validIncompleteSuffix(bytes: Uint8Array): boolean {
  if (bytes.length < 1 || bytes.length > 3) return false;
  const lead = bytes[0];
  const expected = lead >= 0xc2 && lead <= 0xdf ? 2
    : lead >= 0xe0 && lead <= 0xef ? 3
      : lead >= 0xf0 && lead <= 0xf4 ? 4
        : 0;
  if (expected === 0 || bytes.length >= expected) return false;
  for (let index = 1; index < bytes.length; index += 1) {
    if (bytes[index] < 0x80 || bytes[index] > 0xbf) return false;
  }
  if (bytes.length >= 2) {
    const second = bytes[1];
    if ((lead === 0xe0 && second < 0xa0) || (lead === 0xed && second > 0x9f) ||
        (lead === 0xf0 && second < 0x90) || (lead === 0xf4 && second > 0x8f)) return false;
  }
  return true;
}

function decodeFetchedPrefix(prefix: Buffer, complete: boolean): string {
  if (complete) return decodeUtf8(prefix);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(prefix);
  } catch {
    for (let remove = 1; remove <= Math.min(3, prefix.length); remove += 1) {
      const suffix = prefix.subarray(prefix.length - remove);
      if (!validIncompleteSuffix(suffix)) continue;
      try {
        return new TextDecoder("utf-8", { fatal: true }).decode(prefix.subarray(0, -remove));
      } catch {
        // An interior error is not an incomplete boundary.
      }
    }
    failed();
  }
}

function titleFor(row: IdentityRow, prefixLimit: number): { title: string; complete: boolean } {
  const sourceId = row.recordKind === "tracked" ? positiveId(row.taskId) : positiveId(row.sourceId);
  const result = titleStatements[row.recordKind].get(prefixLimit, sourceId) as TitleRow | undefined;
  if (
    !result || result.storageType !== "text" || !Number.isSafeInteger(result.byteLength) ||
    (result.byteLength as number) < 0 || !Buffer.isBuffer(result.prefix)
  ) failed();
  const prefix = result.prefix as Buffer;
  const byteLength = result.byteLength as number;
  const complete = byteLength <= prefixLimit;
  if (prefix.length !== Math.min(byteLength, prefixLimit)) failed();
  return { title: decodeFetchedPrefix(prefix, complete), complete };
}

function baseRecord(row: IdentityRow, requestNow: string, timezone: Parameters<typeof contextDateForInstant>[1]): WeekRecord {
  const sourceId = positiveId(row.sourceId);
  const taskId = positiveId(row.taskId);
  if (row.recordKind === "task") {
    if (sourceId !== taskId || (row.sourceStatus !== "open" && row.sourceStatus !== "done")) failed();
    let fixed: TaskPlanningRecord["fixed"] = null;
    if (row.fixedStart !== null || row.fixedEnd !== null) {
      const start = sourceInstant(row.fixedStart);
      const end = sourceInstant(row.fixedEnd);
      if (end.ms <= start.ms || row.companionStart !== start.ms || row.companionEnd !== end.ms) unavailable();
      fixed = {
        startsAt: start.text,
        endsAt: end.text,
        contextDate: contextDateForInstant(start.text, timezone),
      };
    }
    const deadline = row.deadlineDate === null ? null : { date: String(row.deadlineDate) };
    if (deadline && !/^\d{4}-\d{2}-\d{2}$/.test(deadline.date)) failed();
    if (!fixed && !deadline) failed();
    if (row.sourceStatus === "done" && deadline) failed();
    return {
      kind: "task",
      id: sourceId,
      title: "",
      titleTruncated: false,
      status: row.sourceStatus,
      fixed,
      deadline,
    };
  }
  if (row.recordKind === "goal") {
    if (row.sourceStatus !== "active" || row.deadlineDate === null) failed();
    return {
      kind: "goal",
      id: sourceId,
      title: "",
      titleTruncated: false,
      status: "active",
      deadline: { date: String(row.deadlineDate) },
    } satisfies GoalPlanningRecord;
  }
  if (row.sourceStatus !== "open" && row.sourceStatus !== "done" && row.sourceStatus !== "archived") failed();
  const start = sourceInstant(row.trackedStart);
  const running = row.trackedEnd === null;
  const end = running ? canonicalInstant(requestNow) : sourceInstant(row.trackedEnd);
  if (
    end.ms <= start.ms || row.companionStart !== start.ms ||
    (running ? row.companionEnd !== null : row.companionEnd !== end.ms)
  ) unavailable();
  return {
    kind: "tracked",
    id: sourceId,
    taskId,
    taskStatus: row.sourceStatus,
    title: "",
    titleTruncated: false,
    startedAt: start.text,
    effectiveEndAt: end.text,
    running,
  } satisfies TrackedRecord;
}

function withTitle(record: WeekRecord, title: string, titleTruncated: boolean): WeekRecord {
  return { ...record, title, titleTruncated } as WeekRecord;
}

function reservedBodyBytes(
  request: WeekWorkerRequest,
  records: WeekRecord[],
  hasMore: boolean,
): number {
  return Buffer.byteLength(JSON.stringify({
    weekStart: request.week.weekStart,
    timezone: request.week.timezone,
    requestNow: request.requestNow,
    records,
    nextCursor: hasMore ? "x".repeat(WEEK_CURSOR_RESERVE_CHARS) : null,
  }), "utf8");
}

function largestTitleThatFits(
  request: WeekWorkerRequest,
  base: WeekRecord,
  title: string,
  hasMore: boolean,
  completeSourceTitle: boolean,
): WeekRecord {
  const points = Array.from(title);
  let low = 0;
  // When the complete source title made the intact record too large, the
  // truncated representation must actually omit at least one code point.
  // Merely changing `false` to the one-byte-shorter `true` is not truncation.
  let high = points.length - (completeSourceTitle ? 1 : 0);
  let best: WeekRecord | null = null;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = withTitle(base, points.slice(0, middle).join(""), true);
    if (reservedBodyBytes(request, [candidate], hasMore) <= WEEK_BODY_MAX_BYTES) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  if (!best) failed();
  return best;
}

function queryPage(request: WeekWorkerRequest): WeekWorkerResult {
  const now = canonicalInstant(request.requestNow);
  const params: Record<string, number | string> = {
    rangeStart: request.week.rangeStartMs,
    rangeEnd: request.week.rangeEndMs,
    rangeStartDay: Math.trunc((request.week.rangeStartMs + 62_135_596_800_000) / 86_400_000),
    rangeEndDay: Math.trunc((request.week.rangeEndMs - 1 + 62_135_596_800_000) / 86_400_000),
    requestNow: now.ms,
    hasAfter: request.after ? 1 : 0,
    afterAnchor: request.after?.anchorMs ?? request.week.rangeStartMs,
    afterRank: request.after?.kindRank ?? 0,
    afterId: request.after?.id ?? 0,
  };
  request.week.dates.forEach((value, index) => { params[`d${index}`] = value; });
  request.week.midnightMs.forEach((value, index) => { params[`m${index}`] = value; });

  database.exec("BEGIN");
  let complete = false;
  try {
    let state: Array<Record<string, unknown>>;
    try {
      const version = database.pragma("user_version", { simple: true });
      state = database.prepare(`SELECT singleton,projection_format,ready,
        source_generation AS sourceGeneration,built_generation AS builtGeneration
        FROM week_access_state LIMIT 2`).all() as Array<Record<string, unknown>>;
      if (
        version !== 24 || state.length !== 1 || state[0].singleton !== 1 ||
        state[0].projection_format !== 1 || state[0].ready !== 1 ||
        state[0].sourceGeneration !== state[0].builtGeneration
      ) unavailable();
    } catch (error) {
      if (error instanceof ProjectionError) throw error;
      unavailable();
    }

    let identities: IdentityRow[];
    try {
      identities = database.prepare(WEEK_QUERY_SQL).all(params) as IdentityRow[];
    } catch (error) {
      identityQueryFailure(error);
    }
    if (identities.length > 101) failed();

    const records: WeekRecord[] = [];
    let last: WeekWorkerResult["last"] = null;
    let examined = 0;
    let previous = request.after
      ? [request.after.anchorMs, request.after.kindRank, request.after.id]
      : null;
    for (const identity of identities.slice(0, WEEK_PAGE_SIZE)) {
      examined += 1;
      const anchor = identity.visibleAnchor;
      const rank = identity.kindRank;
      const sourceId = positiveId(identity.sourceId);
      if (!Number.isSafeInteger(anchor) || !Number.isInteger(rank) || ![0, 1, 2].includes(rank as number)) failed();
      if ((anchor as number) < request.week.rangeStartMs || (anchor as number) >= request.week.rangeEndMs) failed();
      const tuple = [anchor as number, rank as number, sourceId];
      if (previous && (
        tuple[0] < previous[0] ||
        (tuple[0] === previous[0] && tuple[1] < previous[1]) ||
        (tuple[0] === previous[0] && tuple[1] === previous[1] && tuple[2] <= previous[2])
      )) failed();
      previous = tuple;

      const base = baseRecord(identity, request.requestNow, request.week.timezone);
      const empty = withTitle(base, "", false);
      const hasMoreAfterIdentity = examined < identities.length || identities.length === 101;
      const titleBudget = WEEK_BODY_MAX_BYTES -
        reservedBodyBytes(request, [...records, empty], hasMoreAfterIdentity);
      if (titleBudget < 0) {
        if (records.length > 0) {
          examined -= 1;
          break;
        }
        failed();
      }
      const fetched = titleFor(identity, titleBudget + 4);
      const intact = withTitle(base, fetched.title, false);
      if (fetched.complete &&
          reservedBodyBytes(request, [...records, intact], hasMoreAfterIdentity) <= WEEK_BODY_MAX_BYTES) {
        records.push(intact);
      } else if (records.length > 0) {
        // The intact identity is retried against an empty page; no partial
        // title or record is emitted on the current page.
        examined -= 1;
        break;
      } else {
        records.push(largestTitleThatFits(
          request,
          base,
          fetched.title,
          hasMoreAfterIdentity,
          fetched.complete,
        ));
      }
      last = { anchor: new Date(anchor as number).toISOString(), kindRank: rank as 0 | 1 | 2, id: sourceId };
    }
    const hasMore = examined < identities.length || identities.length === 101;
    if (hasMore && (records.length === 0 || last === null)) failed();
    database.exec("COMMIT");
    complete = true;
    return { type: "result", id: request.id, records, hasMore, last };
  } finally {
    if (!complete && database.inTransaction) {
      try { database.exec("ROLLBACK"); } catch { /* worker is discarded for an unrollable fault */ }
    }
  }
}

channel.on("message", (message: WeekWorkerRequest | WeekWorkerClose) => {
  if (message.type === "close") {
    try {
      database.close();
      channel.postMessage({ type: "closed" } satisfies WeekWorkerMessage);
      channel.close();
    } catch {
      process.exitCode = 1;
      channel.close();
    }
    return;
  }
  try {
    channel.postMessage(queryPage(message) satisfies WeekWorkerMessage);
  } catch (error) {
    const detail = error instanceof ProjectionError
      ? error
      : new ProjectionError("failed", true);
    channel.postMessage({
      type: "failure",
      id: message.id,
      code: detail.code,
      discard: detail.discard,
    } satisfies WeekWorkerFailure);
  }
});

channel.postMessage({ type: "ready" } satisfies WeekWorkerMessage);
