import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startUpdateScheduler } from "../../src/updateScheduler.js";

// OTA check timer (#247), mirroring backup-scheduler.test.ts: fake timers +
// an injected runCheck so nothing touches the network and NO real timer
// leaks (a leaked interval hangs the vitest run / the Windows E2E teardown).
// Every handle is stopped in the test that created it.
//
// SPEC-FIRST: src/updateScheduler.ts is a TODO-throwing skeleton, so these
// run as `it.fails`. WHEN IMPLEMENTING #247: flip every `it.fails` to `it`.

const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const ok = () => Promise.resolve({ updateAvailable: false });

describe("startUpdateScheduler", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it.fails("is disabled when the interval is <= 0 — returns null, creates no timer", () => {
    // UPDATE_CHECK_INTERVAL_HOURS=0 must mean zero timers AND zero calls
    // (the #235 rule), provable because no scheduler object even exists.
    const runCheck = vi.fn(ok);
    expect(startUpdateScheduler(0, { runCheck })).toBeNull();
    expect(startUpdateScheduler(-1, { runCheck })).toBeNull();
    vi.advanceTimersByTime(72 * HOUR_MS);
    expect(runCheck).not.toHaveBeenCalled();
  });

  it.fails("runs the boot check after the initial delay, not immediately", () => {
    // ~60s after boot (injectable here; production adds jitter) — a check in
    // the boot path itself would put GitHub latency into every restart.
    const runCheck = vi.fn(ok);
    const handle = startUpdateScheduler(24, { runCheck, initialDelayMs: MINUTE_MS })!;
    try {
      expect(runCheck).not.toHaveBeenCalled();
      vi.advanceTimersByTime(MINUTE_MS);
      expect(runCheck).toHaveBeenCalledTimes(1);
    } finally {
      handle.stop();
    }
  });

  it.fails("then checks once per interval — at most one call per period", () => {
    const runCheck = vi.fn(ok);
    const handle = startUpdateScheduler(24, { runCheck, initialDelayMs: MINUTE_MS })!;
    try {
      vi.advanceTimersByTime(MINUTE_MS); // boot check
      vi.advanceTimersByTime(24 * HOUR_MS);
      expect(runCheck).toHaveBeenCalledTimes(2);
      vi.advanceTimersByTime(24 * HOUR_MS);
      expect(runCheck).toHaveBeenCalledTimes(3);
      // Nothing extra in between: half an interval adds no call.
      vi.advanceTimersByTime(12 * HOUR_MS);
      expect(runCheck).toHaveBeenCalledTimes(3);
    } finally {
      handle.stop();
    }
  });

  it.fails("stop() halts the boot check and all further ticks", () => {
    const runCheck = vi.fn(ok);
    const handle = startUpdateScheduler(24, { runCheck, initialDelayMs: MINUTE_MS })!;
    handle.stop();
    vi.advanceTimersByTime(100 * HOUR_MS);
    expect(runCheck).not.toHaveBeenCalled();
  });

  it.fails("a rejecting check is logged and swallowed — the schedule continues", async () => {
    // GitHub down or the Pi offline must cost one log line, nothing else.
    const errors: string[] = [];
    const runCheck = vi.fn(() => Promise.reject(new Error("getaddrinfo ENOTFOUND api.github.com")));
    const handle = startUpdateScheduler(24, {
      runCheck,
      initialDelayMs: MINUTE_MS,
      logError: (m) => errors.push(m),
    })!;
    try {
      await vi.advanceTimersByTimeAsync(MINUTE_MS); // boot tick, microtasks drained
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0]).toContain("ENOTFOUND");
      // The failure did not cancel the schedule.
      await vi.advanceTimersByTimeAsync(24 * HOUR_MS);
      expect(runCheck).toHaveBeenCalledTimes(2);
    } finally {
      handle.stop();
    }
  });
});
