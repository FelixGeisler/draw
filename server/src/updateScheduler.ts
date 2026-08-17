// OTA update-check timer (#247) — SPEC-FIRST SKELETON, mirroring
// backupScheduler.ts exactly:
//
// - Returns null when the interval is <= 0 — no timer object exists at all,
//   so a disabled check is provably zero timers (the #235 rule).
// - NOT started inside createApp(): that runs once per integration test and
//   would leak an interval into every suite. Only prod.ts wires it, from
//   resolveUpdateCheckIntervalHours (default 24, clamped to the int32
//   setInterval cap).
// - First check ~60s after boot (plus jitter, so a fleet of restarts does not
//   stampede GitHub) — `initialDelayMs` makes that boot delay injectable and
//   deterministic under fake timers; production omits it.
// - Every timer is unref'd; the tick calls the gated checkForUpdate() door
//   (which itself makes zero calls when update_check_enabled is off), and a
//   rejecting tick logs one line and is swallowed — the schedule continues.
//
// Behavioral contract: test/unit/update-scheduler.test.ts (it.fails until
// implemented — flip each to it when this lands).

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
  void intervalHours;
  void options;
  throw new Error(
    "TODO(#247): not implemented yet — spec'd in server/test/unit/update-scheduler.test.ts",
  );
}
