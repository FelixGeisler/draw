import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startBackupScheduler } from "../../src/backupScheduler.js";

// Scheduling decisions (#194, ADR-52). Fake timers + an injected runBackup, so
// nothing touches the disk and NO real timer leaks (a leaked interval would
// hang the vitest run / the Windows E2E teardown). Every handle is stopped in
// the test that created it.

const HOUR_MS = 60 * 60 * 1000;
const ok = () => ({ path: "/data/backups/draw-backup-2026-07-26T00-00-00Z.zip", pruned: [] });

describe("startBackupScheduler", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("is disabled when the interval is <= 0 — returns null and creates no timer", () => {
    const runBackup = vi.fn(ok);
    expect(startBackupScheduler(0, 7, { runBackup })).toBeNull();
    expect(startBackupScheduler(-1, 7, { runBackup })).toBeNull();
    vi.advanceTimersByTime(72 * HOUR_MS);
    expect(runBackup).not.toHaveBeenCalled();
  });

  it("runs exactly one backup per interval, none immediately", () => {
    const runBackup = vi.fn(ok);
    const handle = startBackupScheduler(2, 7, { runBackup, log: () => {} });
    expect(handle).not.toBeNull();
    try {
      expect(runBackup).not.toHaveBeenCalled(); // nothing on start
      vi.advanceTimersByTime(2 * HOUR_MS);
      expect(runBackup).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(2 * HOUR_MS);
      expect(runBackup).toHaveBeenCalledTimes(2);
    } finally {
      handle!.stop();
    }
  });

  it("stop() halts all further backups", () => {
    const runBackup = vi.fn(ok);
    const handle = startBackupScheduler(1, 7, { runBackup, log: () => {} })!;
    vi.advanceTimersByTime(1 * HOUR_MS);
    expect(runBackup).toHaveBeenCalledTimes(1);
    handle.stop();
    vi.advanceTimersByTime(10 * HOUR_MS);
    expect(runBackup).toHaveBeenCalledTimes(1);
  });

  it("logs a wrote/pruned line on success", () => {
    const logs: string[] = [];
    const runBackup = vi.fn(() => ({
      path: "/data/backups/draw-backup-2026-07-26T03-00-00Z.zip",
      pruned: ["draw-backup-2026-07-19T03-00-00Z.zip"],
    }));
    const handle = startBackupScheduler(1, 7, { runBackup, log: (m) => logs.push(m) })!;
    try {
      vi.advanceTimersByTime(1 * HOUR_MS);
      expect(logs[0]).toContain("wrote draw-backup-2026-07-26T03-00-00Z.zip");
      expect(logs[0]).toContain("pruned 1");
    } finally {
      handle.stop();
    }
  });

  it("a failing backup is logged and swallowed — the server never crashes (#194)", () => {
    const errors: string[] = [];
    const runBackup = vi.fn(() => {
      throw new Error("ENOSPC: no space left on device");
    });
    const handle = startBackupScheduler(1, 7, { runBackup, logError: (m) => errors.push(m) })!;
    try {
      // The tick throwing must not surface out of the timer callback.
      expect(() => vi.advanceTimersByTime(1 * HOUR_MS)).not.toThrow();
      expect(errors[0]).toContain("scheduled backup failed");
      expect(errors[0]).toContain("ENOSPC");
      // And the schedule keeps going after a failure.
      vi.advanceTimersByTime(1 * HOUR_MS);
      expect(runBackup).toHaveBeenCalledTimes(2);
    } finally {
      handle.stop();
    }
  });
});
