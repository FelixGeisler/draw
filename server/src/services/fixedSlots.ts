import type { SafeDatabase } from "../safeDatabase.js";
import { z } from "zod";
import {
  SCHEDULE_TIME_ZONE_SET,
  SCHEDULE_TIME_ZONES,
  type ScheduleTimeZoneId,
} from "../../../shared/scheduleTimezones.js";

export interface FixedSlotInput {
  startLocal: string;
  endLocal: string;
  entryTimezone: ScheduleTimeZoneId;
}

export interface FixedSlotProjection extends FixedSlotInput {
  startsAt: string;
  endsAt: string;
  startOffsetSeconds: number;
  endOffsetSeconds: number;
}

/**
 * The one caller-input shape shared by REST's resolver, MCP create/update and
 * the reviewed assistant's staged create. The schema deliberately validates
 * only the closed wire shape: the resolver below remains authoritative for
 * Gregorian validity, the frozen zone registry, gaps/folds, UTC-year bounds
 * and instant ordering.
 */
export const fixedSlotInputSchema = z
  .object({
    startLocal: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, "must be YYYY-MM-DDTHH:mm")
      .describe("Exact local wall minute, YYYY-MM-DDTHH:mm, resolved in entryTimezone"),
    endLocal: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, "must be YYYY-MM-DDTHH:mm")
      .describe("Exact local wall minute, YYYY-MM-DDTHH:mm, resolved in entryTimezone"),
    entryTimezone: z
      .string()
      .describe("Exact canonical schedule timezone from Draw's frozen IANA registry, or UTC"),
  })
  .strict()
  .describe("One fixed task slot; resolved instants and offsets are server output only");

export type ParsedFixedSlot =
  | { present: false }
  | { present: true; value: null }
  | { present: true; value: FixedSlotProjection };

const LOCAL_MINUTE_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;
const CANONICAL_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const ZONE_SHAPE_RE = /^[A-Za-z._+-]+\/[A-Za-z0-9._+-]+(?:\/[A-Za-z0-9._+-]+)*$/;

interface WallMinute {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  text: string;
  pseudoUtcMs: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let value = formatters.get(timeZone);
  if (!value) {
    value = new Intl.DateTimeFormat("en-CA-u-ca-gregory-nu-latn", {
      timeZone,
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
    formatters.set(timeZone, value);
  }
  return value;
}

function utcMs(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second = 0,
  millisecond = 0,
): number {
  const value = new Date(0);
  value.setUTCHours(hour, minute, second, millisecond);
  value.setUTCFullYear(year, month - 1, day);
  return value.getTime();
}

function parseWallMinute(value: unknown, field: string): WallMinute {
  if (typeof value !== "string") throw new Error(`${field} must be a local wall minute`);
  const match = LOCAL_MINUTE_RE.exec(value);
  if (!match) {
    throw new Error(`${field} must use exact YYYY-MM-DDTHH:mm local wall-minute syntax`);
  }
  const [, y, mo, d, h, mi] = match;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const hour = Number(h);
  const minute = Number(mi);
  if (year < 1 || year > 9999 || month < 1 || month > 12 || hour > 23 || minute > 59) {
    throw new Error(`${field} is not a real Gregorian wall minute`);
  }
  const pseudoUtcMs = utcMs(year, month, day, hour, minute);
  const roundTrip = new Date(pseudoUtcMs);
  if (
    roundTrip.getUTCFullYear() !== year ||
    roundTrip.getUTCMonth() !== month - 1 ||
    roundTrip.getUTCDate() !== day ||
    roundTrip.getUTCHours() !== hour ||
    roundTrip.getUTCMinutes() !== minute
  ) {
    throw new Error(`${field} is not a real Gregorian wall minute`);
  }
  return { year, month, day, hour, minute, text: value, pseudoUtcMs };
}

function wallAt(instantMs: number, timeZone: string): Omit<WallMinute, "text"> & { second: number } {
  const parts = formatter(timeZone).formatToParts(new Date(instantMs));
  const values = new Map(parts.map((part) => [part.type, part.value]));
  const year = Number(values.get("year"));
  const month = Number(values.get("month"));
  const day = Number(values.get("day"));
  let hour = Number(values.get("hour"));
  const minute = Number(values.get("minute"));
  const second = Number(values.get("second"));
  // Some ICU builds can render midnight as 24 despite h23. Treat it as the
  // same day's 00:00; all accepted inputs use 00 and validation is by parts.
  if (hour === 24) hour = 0;
  return {
    year,
    month,
    day,
    hour,
    minute,
    second,
    pseudoUtcMs: utcMs(year, month, day, hour, minute, second),
  };
}

function sameMinute(left: WallMinute, right: ReturnType<typeof wallAt>): boolean {
  return (
    left.year === right.year &&
    left.month === right.month &&
    left.day === right.day &&
    left.hour === right.hour &&
    left.minute === right.minute
  );
}

function canonicalInstant(instantMs: number, field: string): string {
  const instant = new Date(instantMs);
  const year = instant.getUTCFullYear();
  if (!Number.isFinite(instantMs) || year < 1 || year > 9999) {
    throw new Error(`${field} resolves outside supported UTC years 0001-9999`);
  }
  const iso = instant.toISOString();
  if (!CANONICAL_INSTANT_RE.test(iso)) {
    throw new Error(`${field} resolves outside the four-digit UTC instant contract`);
  }
  return iso;
}

export function isScheduleTimeZone(value: unknown): value is ScheduleTimeZoneId {
  if (typeof value !== "string") return false;
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes < 1 || bytes > 128 || !/^[\x00-\x7f]+$/.test(value)) return false;
  if (value !== "UTC" && !ZONE_SHAPE_RE.test(value)) return false;
  return SCHEDULE_TIME_ZONE_SET.has(value);
}

/** Fail closed when a checked-in canonical zone is absent from deployed ICU. */
export function assertScheduleTimeZoneRuntime(): void {
  for (const zone of SCHEDULE_TIME_ZONES) {
    try {
      formatter(zone).format(0);
    } catch {
      throw new Error(`schedule timezone registry is unsupported by this Node/ICU build: ${zone}`);
    }
  }
}

/**
 * Resolve a strict local wall minute. Candidate offsets are sampled around the
 * nominal UTC value, then every matching instant is considered. A gap has no
 * match; a fold has two and the earliest instant is selected by sorting.
 */
export function resolveWallMinute(
  value: unknown,
  timeZone: ScheduleTimeZoneId,
  field: string,
): { local: string; instant: string; offsetSeconds: number } {
  const wall = parseWallMinute(value, field);
  const offsets = new Set<number>();
  // Three days catches every tzdb transition near a civil minute, including
  // historical date-line jumps; six-hour samples see both sides of ordinary
  // and multi-hour changes without guessing the host's current offset.
  for (let hours = -72; hours <= 72; hours += 6) {
    const probe = wall.pseudoUtcMs + hours * 3_600_000;
    const shown = wallAt(probe, timeZone);
    offsets.add(Math.round((shown.pseudoUtcMs - probe) / 1000));
  }
  const matches: Array<{ ms: number; offsetSeconds: number }> = [];
  for (const offsetSeconds of offsets) {
    const ms = wall.pseudoUtcMs - offsetSeconds * 1000;
    const shown = wallAt(ms, timeZone);
    if (sameMinute(wall, shown)) matches.push({ ms, offsetSeconds });
  }
  matches.sort((left, right) => left.ms - right.ms);
  const match = matches[0];
  if (!match) throw new Error(`${field} is a nonexistent wall minute in ${timeZone}`);
  return {
    local: wall.text,
    instant: canonicalInstant(match.ms, field),
    offsetSeconds: match.offsetSeconds,
  };
}

export function parseFixedSlotInput(body: Record<string, unknown>): ParsedFixedSlot {
  if (!("fixedSlot" in body)) return { present: false };
  if (body.fixedSlot === null) return { present: true, value: null };
  if (typeof body.fixedSlot !== "object" || Array.isArray(body.fixedSlot)) {
    throw new Error("fixedSlot must be an object or null");
  }
  const input = body.fixedSlot as Record<string, unknown>;
  const keys = Object.keys(input).sort();
  const expected = ["endLocal", "entryTimezone", "startLocal"];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new Error("fixedSlot must contain exactly startLocal, endLocal and entryTimezone");
  }
  if (!isScheduleTimeZone(input.entryTimezone)) {
    throw new Error("fixedSlot.entryTimezone is not a supported canonical schedule timezone");
  }
  const start = resolveWallMinute(input.startLocal, input.entryTimezone, "fixedSlot.startLocal");
  const end = resolveWallMinute(input.endLocal, input.entryTimezone, "fixedSlot.endLocal");
  if (end.instant <= start.instant) {
    throw new Error("fixedSlot.endLocal must resolve after fixedSlot.startLocal");
  }
  return {
    present: true,
    value: {
      startLocal: start.local,
      endLocal: end.local,
      entryTimezone: input.entryTimezone,
      startsAt: start.instant,
      endsAt: end.instant,
      startOffsetSeconds: start.offsetSeconds,
      endOffsetSeconds: end.offsetSeconds,
    },
  };
}

export function fixedSlotFromStored(
  startsAt: unknown,
  endsAt: unknown,
  entryTimezone: unknown,
): FixedSlotProjection | null {
  if (startsAt == null && endsAt == null && entryTimezone == null) return null;
  if (
    typeof startsAt !== "string" ||
    typeof endsAt !== "string" ||
    !isScheduleTimeZone(entryTimezone) ||
    !CANONICAL_INSTANT_RE.test(startsAt) ||
    !CANONICAL_INSTANT_RE.test(endsAt)
  ) {
    throw new Error("stored fixed slot does not satisfy schema v22");
  }
  const project = (instant: string) => {
    const ms = new Date(instant).getTime();
    const wall = wallAt(ms, entryTimezone);
    const local = `${String(wall.year).padStart(4, "0")}-${String(wall.month).padStart(2, "0")}-${String(wall.day).padStart(2, "0")}T${String(wall.hour).padStart(2, "0")}:${String(wall.minute).padStart(2, "0")}`;
    return { local, offsetSeconds: Math.round((wall.pseudoUtcMs - ms) / 1000) };
  };
  const start = project(startsAt);
  const end = project(endsAt);
  return {
    startLocal: start.local,
    endLocal: end.local,
    entryTimezone,
    startsAt,
    endsAt,
    startOffsetSeconds: start.offsetSeconds,
    endOffsetSeconds: end.offsetSeconds,
  };
}

export function validateStoredFixedSlot(
  startsAt: unknown,
  endsAt: unknown,
  entryTimezone: unknown,
): void {
  const projection = fixedSlotFromStored(startsAt, endsAt, entryTimezone);
  if (!projection || projection.endsAt <= projection.startsAt) {
    throw new Error("schema v22 contract mismatch: invalid fixed slot order");
  }
  for (const [field, instant] of [
    ["starts_at", projection.startsAt],
    ["ends_at", projection.endsAt],
  ] as const) {
    const parsed = new Date(instant);
    if (parsed.toISOString() !== instant || parsed.getUTCFullYear() < 1 || parsed.getUTCFullYear() > 9999) {
      throw new Error(`schema v22 contract mismatch: ${field} canonical instant`);
    }
  }
  // Every stored instant must be the earlier resolution of the wall value it
  // projects to. This detects tampered gap/fold rows as well as zone drift.
  const start = resolveWallMinute(projection.startLocal, projection.entryTimezone, "starts_at");
  const end = resolveWallMinute(projection.endLocal, projection.entryTimezone, "ends_at");
  if (start.instant !== projection.startsAt || end.instant !== projection.endsAt) {
    throw new Error("schema v22 contract mismatch: fixed slot wall/instant round trip");
  }
}

export type FixedIntervalMaintainer = (taskId: number, write: () => void) => void;

export function applyFixedSlot(
  database: SafeDatabase,
  taskId: number,
  parsed: ParsedFixedSlot,
  maintainInterval: FixedIntervalMaintainer,
): void {
  if (!parsed.present) return;
  maintainInterval(taskId, () => {
    if (parsed.value === null) {
      database.prepare("DELETE FROM task_fixed_slots WHERE task_id = ?").run(taskId);
    } else {
      database
        .prepare(
          `INSERT INTO task_fixed_slots (task_id, starts_at, ends_at, entry_timezone)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(task_id) DO UPDATE SET
             starts_at = excluded.starts_at,
             ends_at = excluded.ends_at,
             entry_timezone = excluded.entry_timezone`,
        )
        .run(taskId, parsed.value.startsAt, parsed.value.endsAt, parsed.value.entryTimezone);
    }
  });
}

export const FIXED_RECURRENCE_ERROR =
  "a task cannot have both a fixed slot and recurEveryDays; clear recurrence while setting the slot, or clear the slot while setting recurrence";

export function finalHasFixedSlot(current: boolean, parsed: ParsedFixedSlot): boolean {
  return parsed.present ? parsed.value !== null : current;
}

/** Authoritative stored-state invariant check, called before transaction commit. */
export function taskHasFixedRecurrenceConflict(
  database: SafeDatabase,
  taskId: number,
): boolean {
  return Boolean(
    database
      .prepare(
        `SELECT 1 FROM tasks t
         JOIN task_fixed_slots s ON s.task_id = t.id
         WHERE t.id = ? AND t.recur_every_days IS NOT NULL`,
      )
      .get(taskId),
  );
}
