import crypto from "node:crypto";
import type Database from "better-sqlite3";
import { PushService, type DigestClaim, type SendRow } from "./service.js";
import { evaluateDigestEligibility, readDigestTiming } from "./digestEvaluator.js";

export const DIGEST_TICK_MS = 60_000;
export const DIGEST_DEVICE_LIMIT = 16;

interface TimerHandle { unref?: () => void }
export interface DigestTimer {
  set(callback: () => void, delayMs: number): TimerHandle;
  clear(handle: TimerHandle): void;
}

export interface DigestSchedulerOptions {
  database: () => Database.Database;
  push: PushService;
  now?: () => Date;
  timer?: DigestTimer;
  log?: (message: string) => void;
}

export interface DigestScheduler {
  stop(): void;
  /** Deterministic internal assembly seam; production runs use the timer. */
  runNow(): Promise<void>;
}

const defaultTimer: DigestTimer = {
  set: (callback, delayMs) => setTimeout(callback, delayMs),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function digestEventId(localDate: string): string {
  return crypto.createHash("sha256")
    .update(Buffer.from(JSON.stringify(["digest", localDate]), "utf8"))
    .digest().subarray(0, 16).toString("base64url");
}

function eligibleDevices(database: Database.Database, now: Date): { id: string }[] {
  return database.prepare(
    `SELECT id FROM push_subscriptions
     WHERE expiration_time IS NULL OR
       (typeof(expiration_time)='integer' AND expiration_time > ? AND expiration_time <= 8640000000000000)
     ORDER BY id LIMIT ?`,
  ).all(now.valueOf(), DIGEST_DEVICE_LIMIT) as { id: string }[];
}

function claim(
  database: Database.Database,
  push: PushService,
  deviceId: string,
  now: Date,
): DigestClaim | null {
  return database.transaction(() => {
    const context = push.digestClaimContext();
    if (!context) return null;
    const timing = readDigestTiming(database);
    if (!timing?.timezone) return null;
    const eligibility = evaluateDigestEligibility(timing, now);
    if (!eligibility) return null;
    const subscription = database.prepare(
      `SELECT id,endpoint,p256dh,auth,expiration_time,created_at,last_seen_at
       FROM push_subscriptions WHERE id=?`,
    ).get(deviceId) as SendRow | undefined;
    if (!subscription || subscription.expiration_time !== null &&
      (!Number.isSafeInteger(subscription.expiration_time) || subscription.expiration_time <= now.valueOf())) return null;
    const hide = database.prepare("SELECT value FROM settings WHERE key='push_hide_details'").get() as
      { value: string } | undefined;
    if (!hide || hide.value !== "0" && hide.value !== "1") return null;
    const inserted = database.prepare(
      "INSERT OR IGNORE INTO daily_digest_claims(device_id,local_date) VALUES (?,?)",
    ).run(deviceId, eligibility.localDate);
    if (inserted.changes !== 1) return null;
    return {
      deviceId,
      localDate: eligibility.localDate,
      eventId: digestEventId(eligibility.localDate),
      subscription,
      workGeneration: context.workGeneration,
      signing: context.signing,
      timing: { ...timing, timezone: timing.timezone },
      hideDetails: hide.value,
    };
  })();
}

export function startDigestScheduler(options: DigestSchedulerOptions): DigestScheduler {
  const timer = options.timer ?? defaultTimer;
  const now = options.now ?? (() => new Date());
  const log = options.log ?? ((message: string) => console.error(message));
  let stopped = false;
  let running = false;
  let pending: TimerHandle | null = null;
  let activeAbort: AbortController | null = null;

  const schedule = () => {
    if (stopped) return;
    pending = timer.set(() => {
      pending = null;
      void run().finally(schedule);
    }, DIGEST_TICK_MS);
    pending.unref?.();
  };

  const run = async () => {
    if (stopped || running) return;
    running = true;
    activeAbort = new AbortController();
    try {
      if (!options.push.snapshot().available || !options.push.digestClaimContext()) return;
      const instant = now();
      const database = options.database();
      const timing = readDigestTiming(database);
      if (!timing?.timezone || !evaluateDigestEligibility(timing, instant)) return;
      const rows = eligibleDevices(database, instant);
      let index = 0;
      while (!stopped && index < rows.length) {
        const batch: Promise<void>[] = [];
        while (!stopped && index < rows.length) {
          const permit = options.push.tryAcquireDigest();
          if (!permit) break;
          const row = rows[index++];
          const occurrence = claim(options.database(), options.push, row.id, now());
          if (!occurrence) {
            permit.release();
            continue;
          }
          batch.push(options.push.sendDigest(occurrence, now, activeAbort.signal).finally(permit.release));
        }
        if (batch.length === 0) break;
        await Promise.allSettled(batch);
      }
    } catch {
      log("[push] digest tick failed (redacted)");
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
