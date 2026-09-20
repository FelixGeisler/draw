import crypto from "node:crypto";
import type Database from "better-sqlite3";
import { PushService, type DeadlineClaimedOccurrence, type SendRow } from "./service.js";
import {
  addCalendarDays,
  createZonedFormatter,
  LEAD_DAYS,
  occurrenceEligible,
  QUARTER_HOUR,
  scheduledDateTime,
  validCalendarDate,
  validTimeZone,
  zonedMinute,
  type DeadlineTiming,
} from "./deadlineEvaluator.js";

export const DEADLINE_TICK_MS = 60_000;
export const DEADLINE_EXAMINE_LIMIT = 256;
export const DEADLINE_ATTEMPT_LIMIT = 32;
export const DEADLINE_PRUNE_LIMIT = 500;

interface CandidateRow {
  device_id: string;
  item_type: "task" | "goal";
  item_id: number;
  item_created_at: string;
  deadline: string;
}

interface TimerHandle { unref?: () => void }
export interface DeadlineTimer {
  set(callback: () => void, delayMs: number): TimerHandle;
  clear(handle: TimerHandle): void;
}

export interface DeadlineSchedulerOptions {
  database: () => Database.Database;
  push: PushService;
  now?: () => Date;
  timer?: DeadlineTimer;
  log?: (message: string) => void;
}

export interface DeadlineScheduler {
  stop(): void;
  /** Deterministic internal assembly seam; production runs use the timer. */
  runNow(): Promise<void>;
}

const defaultTimer: DeadlineTimer = {
  set: (callback, delayMs) => setTimeout(callback, delayMs),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

function readTiming(database: Database.Database): DeadlineTiming | null {
  const rows = database.prepare(
    `SELECT key, value FROM settings WHERE key IN
     ('push_lead_days','push_send_time','push_timezone','push_quiet_start','push_quiet_end')`,
  ).all() as { key: string; value: string | null }[];
  const values = new Map(rows.map((row) => [row.key, row.value]));
  const leadDays = Number(values.get("push_lead_days"));
  const sendTime = values.get("push_send_time");
  const timezone = values.get("push_timezone");
  const quietStart = values.get("push_quiet_start") ?? null;
  const quietEnd = values.get("push_quiet_end") ?? null;
  if (!Number.isInteger(leadDays) || !LEAD_DAYS.has(leadDays) || typeof sendTime !== "string" ||
    !QUARTER_HOUR.test(sendTime) || !validTimeZone(timezone)) return null;
  const quietValid = quietStart === null && quietEnd === null ||
    typeof quietStart === "string" && typeof quietEnd === "string" &&
      QUARTER_HOUR.test(quietStart) && QUARTER_HOUR.test(quietEnd) && quietStart !== quietEnd;
  if (!quietValid) return null;
  return { leadDays, sendTime, timezone, quietStart, quietEnd };
}

export function deadlineEventId(
  itemType: "task" | "goal",
  itemId: number,
  itemCreatedAt: string,
  deadline: string,
): string {
  return crypto.createHash("sha256")
    .update(Buffer.from(JSON.stringify([itemType, itemId, itemCreatedAt, deadline]), "utf8"))
    .digest().subarray(0, 16).toString("base64url");
}

interface EligibleDate {
  deadline: string;
  scheduled: string;
}

function eligibleDueDates(timing: DeadlineTiming, now: ReturnType<typeof zonedMinute>): EligibleDate[] {
  const dates: EligibleDate[] = [];
  for (let offset = 0; offset <= timing.leadDays; offset++) {
    const deadline = addCalendarDays(now.date, offset);
    if (deadline === null || !occurrenceEligible(deadline, timing, now)) continue;
    const scheduled = scheduledDateTime(deadline, timing);
    if (scheduled !== null) dates.push({ deadline, scheduled });
  }
  return dates;
}

/** Stable SQL factory exported only so tests can execute EXPLAIN on the exact production query. */
export function deadlineCandidateSql(eligibleDateCount: number): string {
  if (!Number.isInteger(eligibleDateCount) || eligibleDateCount < 1 || eligibleDateCount > 31) {
    throw new Error("invalid eligible deadline count");
  }
  const dateValues = Array.from({ length: eligibleDateCount }, () => "(?, ?)").join(",");
  return `WITH
    eligible_dates(deadline, scheduled) AS MATERIALIZED (VALUES ${dateValues}),
    eligible_devices(device_id) AS MATERIALIZED (
      SELECT id FROM push_subscriptions
      WHERE expiration_time IS NULL OR
        (typeof(expiration_time) = 'integer' AND expiration_time > ? AND expiration_time <= 8640000000000000)
      ORDER BY id LIMIT 16
    ),
    source_entities(item_type,item_id,item_created_at,deadline,scheduled) AS (
      SELECT 'task', t.id, t.created_at, t.due_date, d.scheduled
      FROM tasks t JOIN eligible_dates d ON d.deadline = t.due_date
      WHERE t.status = 'open'
      UNION ALL
      SELECT 'goal', g.id, g.created_at, g.target_date, d.scheduled
      FROM goals g JOIN eligible_dates d ON d.deadline = g.target_date
      WHERE g.status = 'active'
    ),
    eligible_entities AS MATERIALIZED (
      SELECT e.item_type,e.item_id,e.item_created_at,e.deadline,e.scheduled
      FROM source_entities e
      WHERE EXISTS (
        SELECT 1 FROM eligible_devices d
        WHERE NOT EXISTS (
          SELECT 1 FROM deadline_reminder_claims c
          WHERE c.device_id=d.device_id AND c.item_type=e.item_type AND c.item_id=e.item_id
            AND c.item_created_at=e.item_created_at AND c.deadline=e.deadline
        )
      )
      ORDER BY e.scheduled,e.deadline,e.item_type,e.item_id,e.item_created_at
      LIMIT ${DEADLINE_EXAMINE_LIMIT}
    )
    SELECT d.device_id,e.item_type,e.item_id,e.item_created_at,e.deadline
    FROM eligible_entities e CROSS JOIN eligible_devices d
    WHERE NOT EXISTS (
      SELECT 1 FROM deadline_reminder_claims c
      WHERE c.device_id=d.device_id AND c.item_type=e.item_type AND c.item_id=e.item_id
        AND c.item_created_at=e.item_created_at AND c.deadline=e.deadline
    )
    ORDER BY e.scheduled,e.deadline,e.item_type,e.item_id,e.item_created_at,d.device_id
    LIMIT ${DEADLINE_EXAMINE_LIMIT}`;
}

function candidates(
  database: Database.Database,
  dates: EligibleDate[],
  nowInstant: Date,
): CandidateRow[] {
  if (dates.length === 0) return [];
  return database.prepare(deadlineCandidateSql(dates.length)).all(
    ...dates.flatMap(({ deadline, scheduled }) => [deadline, scheduled]),
    nowInstant.valueOf(),
  ) as CandidateRow[];
}

function prune(database: Database.Database, localDate: string): void {
  database.prepare(
    `DELETE FROM deadline_reminder_claims WHERE rowid IN (
       SELECT c.rowid FROM deadline_reminder_claims c
       WHERE c.deadline < ? OR
         (c.item_type = 'task' AND NOT EXISTS (
           SELECT 1 FROM tasks t WHERE t.id=c.item_id AND t.created_at=c.item_created_at)) OR
         (c.item_type = 'goal' AND NOT EXISTS (
           SELECT 1 FROM goals g WHERE g.id=c.item_id AND g.created_at=c.item_created_at))
       ORDER BY c.rowid LIMIT ?
     )`,
  ).run(localDate, DEADLINE_PRUNE_LIMIT);
}

function claim(
  database: Database.Database,
  push: PushService,
  candidate: CandidateRow,
  nowInstant: Date,
  localMinute: (timezone: string, instant: Date) => ReturnType<typeof zonedMinute>,
): DeadlineClaimedOccurrence | null {
  return database.transaction(() => {
    const context = push.deadlineClaimContext();
    if (!context) return null;
    const timing = readTiming(database);
    if (!timing || !timing.timezone) return null;
    const now = localMinute(timing.timezone, nowInstant);
    const source = candidate.item_type === "task"
      ? database.prepare(
        "SELECT id, created_at, due_date AS deadline, status FROM tasks WHERE id = ?",
      ).get(candidate.item_id) as { id: number; created_at: string; deadline: string | null; status: string } | undefined
      : database.prepare(
        "SELECT id, created_at, target_date AS deadline, status FROM goals WHERE id = ?",
      ).get(candidate.item_id) as { id: number; created_at: string; deadline: string | null; status: string } | undefined;
    const expectedStatus = candidate.item_type === "task" ? "open" : "active";
    if (!source || source.status !== expectedStatus || source.created_at !== candidate.item_created_at ||
      source.deadline !== candidate.deadline || !validCalendarDate(source.deadline) ||
      !occurrenceEligible(source.deadline, timing, now)) return null;
    const subscription = database.prepare(
      `SELECT id, endpoint, p256dh, auth, expiration_time, created_at, last_seen_at
       FROM push_subscriptions WHERE id = ?`,
    ).get(candidate.device_id) as SendRow | undefined;
    if (!subscription || subscription.expiration_time !== null &&
      (!Number.isSafeInteger(subscription.expiration_time) || subscription.expiration_time <= nowInstant.valueOf())) return null;
    const hide = database.prepare("SELECT value FROM settings WHERE key='push_hide_details'").get() as { value: string } | undefined;
    if (!hide) return null;
    const inserted = database.prepare(
      `INSERT OR IGNORE INTO deadline_reminder_claims
       (device_id,item_type,item_id,item_created_at,deadline) VALUES (?,?,?,?,?)`,
    ).run(candidate.device_id, candidate.item_type, candidate.item_id, candidate.item_created_at, candidate.deadline);
    if (inserted.changes !== 1) return null;
    return {
      deviceId: candidate.device_id,
      itemType: candidate.item_type,
      itemId: candidate.item_id,
      itemCreatedAt: candidate.item_created_at,
      deadline: candidate.deadline,
      eventId: deadlineEventId(candidate.item_type, candidate.item_id, candidate.item_created_at, candidate.deadline),
      subscription,
      workGeneration: context.workGeneration,
      signing: context.signing,
      hideDetails: hide.value,
    };
  })();
}

export function startDeadlineScheduler(options: DeadlineSchedulerOptions): DeadlineScheduler {
  const timer = options.timer ?? defaultTimer;
  const now = options.now ?? (() => new Date());
  const log = options.log ?? ((message: string) => console.error(message));
  let stopped = false;
  let running = false;
  let pending: TimerHandle | null = null;
  let activeAbort: AbortController | null = null;
  let formatterZone: string | null = null;
  let formatter: Intl.DateTimeFormat | null = null;
  const localMinute = (timezone: string, instant: Date) => {
    if (formatterZone !== timezone || formatter === null) {
      formatterZone = timezone;
      formatter = createZonedFormatter(timezone);
    }
    return zonedMinute(formatter, instant);
  };

  const schedule = () => {
    if (stopped) return;
    pending = timer.set(() => {
      pending = null;
      void run().finally(schedule);
    }, DEADLINE_TICK_MS);
    pending.unref?.();
  };

  const run = async () => {
    if (stopped || running) return;
    running = true;
    activeAbort = new AbortController();
    try {
      // Availability is the first gate: unavailable/recovery states do not
      // touch reminder settings, subscriptions, candidates, claims or pruning.
      if (!options.push.snapshot().available || !options.push.deadlineClaimContext()) return;
      const database = options.database();
      const timing = readTiming(database);
      if (!timing?.timezone) return;
      const subscription = database.prepare("SELECT 1 AS present FROM push_subscriptions LIMIT 1").get();
      if (!subscription) return;
      const instant = now();
      const local = localMinute(timing.timezone, instant);
      prune(database, local.date);
      const rows = candidates(database, eligibleDueDates(timing, local), instant);
      let index = 0;
      let admitted = 0;
      while (!stopped && index < rows.length && admitted < DEADLINE_ATTEMPT_LIMIT) {
        const batch: Promise<void>[] = [];
        while (!stopped && index < rows.length && admitted < DEADLINE_ATTEMPT_LIMIT) {
          const permit = options.push.tryAcquireDeadline();
          if (!permit) break;
          const row = rows[index++];
          const occurrence = claim(options.database(), options.push, row, now(), localMinute);
          if (!occurrence) {
            permit.release();
            continue;
          }
          admitted += 1;
          batch.push(options.push.sendDeadline(occurrence, activeAbort.signal).finally(permit.release));
        }
        if (batch.length === 0) break;
        await Promise.allSettled(batch);
      }
    } catch {
      log("[push] deadline tick failed (redacted)");
    } finally {
      activeAbort = null;
      running = false;
    }
  };

  schedule();
  return {
    stop() {
      if (stopped) return;
      stopped = true;
      if (pending) timer.clear(pending);
      pending = null;
      activeAbort?.abort();
    },
    runNow: run,
  };
}
