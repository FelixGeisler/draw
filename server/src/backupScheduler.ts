// Periodic backup timer (#194, ADR-52). Deliberately NOT started inside
// createApp(): that runs once per integration test, and a live setInterval
// there would leak a timer into every test and keep the process alive. The
// production entry (prod.ts) starts it alongside startServer; tests drive the
// work directly via runScheduledBackup, or exercise the scheduling decisions
// here with an injected runBackup and vitest fake timers.
import { basename } from "node:path";
import { runScheduledBackup, type ScheduledBackupResult } from "./services/backupService.js";

export interface BackupScheduler {
  /** Stop the timer — no further backups run. Idempotent. */
  stop(): void;
}

export interface BackupSchedulerOptions {
  log?: (message: string) => void;
  logError?: (message: string) => void;
  /** Injectable tick for unit tests — defaults to a real scheduled backup. */
  runBackup?: () => ScheduledBackupResult;
}

/**
 * Start the periodic backup timer. Returns null when disabled
 * (`intervalHours <= 0`) so a caller/test can assert "no timer was created" —
 * the disabled path is the unchanged-behavior default. Otherwise returns a
 * handle whose `stop()` clears the interval (shutdown and tests must not leak
 * timers). The timer is `unref`'d so it never keeps the process alive on its
 * own. A failing backup is logged and swallowed — a scheduled backup must NEVER
 * crash the server (#194). No backup runs immediately; the first lands after
 * one interval.
 */
export function startBackupScheduler(
  intervalHours: number,
  retention: number,
  options: BackupSchedulerOptions = {},
): BackupScheduler | null {
  if (!(intervalHours > 0)) return null;

  const log = options.log ?? ((m) => console.log(m));
  const logError = options.logError ?? ((m) => console.error(m));
  const runBackup = options.runBackup ?? (() => runScheduledBackup(retention));

  const tick = () => {
    try {
      const { path, pruned } = runBackup();
      const prunedNote =
        pruned.length > 0 ? `; pruned ${pruned.length} old archive(s): ${pruned.join(", ")}` : "";
      log(`[backup] wrote ${basename(path)}${prunedNote}`);
    } catch (e) {
      logError(`[backup] scheduled backup failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const timer = setInterval(tick, intervalHours * 60 * 60 * 1000);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
