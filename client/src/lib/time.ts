/**
 * Shared time formatting for the timer surfaces (TimerBar, FocusOverlay).
 * Pure functions — callers pass `Date.now()` in, so the 1 s tick stays a
 * component concern and everything here is unit-testable with fixed clocks.
 */

/** Whole seconds since an ISO start timestamp, floored at 0 (clock skew). */
export function elapsedSeconds(startedAt: string, now: number): number {
  return Math.max(0, Math.floor((now - new Date(startedAt).getTime()) / 1000));
}

/** "m:ss", rolling over to "h:mm:ss" past the hour (TimerBar's format). */
export function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, totalSeconds);
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m >= 60) {
    const h = Math.floor(m / 60);
    return `${h}:${String(m % 60).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** Running-timer display, extracted from TimerBar (issue #56). */
export function formatElapsed(startedAt: string, now: number): string {
  return formatDuration(elapsedSeconds(startedAt, now));
}

export type FocusClock =
  | { mode: "countdown"; text: string }
  | { mode: "overtime"; text: string }
  | { mode: "countup"; text: string };

/**
 * Focus-mode clock face (issue #56). Counts DOWN the effort estimate, then
 * flips to a visually distinct count-UP of the overrun. Display only — the
 * clock never stops the timer and never completes the task; overrunning is
 * allowed. A missing estimate (the timer state is generic even though drawn
 * cards always carry one) degrades to a plain count-up like the TimerBar.
 */
export function focusClock(
  effortMinutes: number | null | undefined,
  startedAt: string,
  now: number,
): FocusClock {
  const elapsed = elapsedSeconds(startedAt, now);
  if (effortMinutes == null) return { mode: "countup", text: formatDuration(elapsed) };
  const remaining = effortMinutes * 60 - elapsed;
  if (remaining >= 0) return { mode: "countdown", text: formatDuration(remaining) };
  return { mode: "overtime", text: `+${formatDuration(-remaining)} over` };
}
