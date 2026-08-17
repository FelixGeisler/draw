// OTA update-check timer (#247), mirroring backupScheduler.ts:
//
// - Returns null when the interval is <= 0 — no timer object exists at all,
//   so a disabled check is provably zero timers (the #235 rule).
// - NOT started inside createApp(): that runs once per integration test and
//   would leak an interval into every suite. Only prod.ts wires it, from
//   resolveUpdateCheckIntervalHours (default 24, clamped to the int32
//   setInterval cap).
// - First check ~60s after boot plus jitter (a fleet of restarts must not
//   stampede GitHub) — `initialDelayMs` makes that boot delay injectable and
//   deterministic under fake timers; production omits it.
// - Every timer is unref'd; the tick calls the gated checkForUpdate() door
//   (which itself makes zero calls when update_check_enabled is off), and a
//   rejecting tick logs one line and is swallowed — the schedule continues.
//
// Behavioral contract: test/unit/update-scheduler.test.ts.

import { checkForUpdate } from "./services/updateService.js";

export interface UpdateScheduler {
  /** Idempotent. */
  stop(): void;
}

export interface UpdateSchedulerOptions {
  /** Injected tick for tests; defaults to services/updateService checkForUpdate. */
  runCheck?: () => Promise<unknown>;
  /** Boot-check delay override for tests; production derives ~60s + jitter. */
  initialDelayMs?: number;
  log?: (message: string) => void;
  logError?: (message: string) => void;
}

export function startUpdateScheduler(
  intervalHours: number,
  options: UpdateSchedulerOptions = {},
): UpdateScheduler | null {
  if (!(intervalHours > 0)) return null;

  const log = options.log ?? ((m) => console.log(m));
  const logError = options.logError ?? ((m) => console.error(m));
  const runCheck = options.runCheck ?? (() => checkForUpdate());
  // ~60s + up to 30s jitter: the check stays out of the boot path (GitHub
  // latency must not slow a restart), and simultaneous restarts spread out.
  const initialDelayMs = options.initialDelayMs ?? 60_000 + Math.floor(Math.random() * 30_000);

  // runCheck is invoked synchronously inside the timer callback (a throwing
  // check still lands in the rejection path via Promise.resolve wrapping a
  // try) — only the result handling is async.
  const tick = () => {
    let pending: Promise<unknown>;
    try {
      pending = Promise.resolve(runCheck());
    } catch (e) {
      logError(`[update] check failed: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    void pending
      .then((result) => {
        const status = result as { updateAvailable?: boolean; latest?: string | null } | undefined;
        if (status?.updateAvailable) {
          log(`[update] update available: ${status.latest ?? "unknown"}`);
        }
      })
      .catch((e: unknown) => {
        logError(`[update] check failed: ${e instanceof Error ? e.message : String(e)}`);
      });
  };

  let interval: NodeJS.Timeout | null = null;
  const boot = setTimeout(() => {
    tick();
    interval = setInterval(tick, intervalHours * 60 * 60 * 1000);
    interval.unref?.();
  }, initialDelayMs);
  boot.unref?.();

  return {
    stop: () => {
      clearTimeout(boot);
      if (interval) clearInterval(interval);
    },
  };
}
