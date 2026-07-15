import type { Goal } from "../api/types";

/**
 * Goal feasibility burn-down (#60): pure classification of whether the
 * current working pace still fits the remaining work into the days left.
 * Same pattern as effort.ts / snooze.ts — no fetching, injectable `now`,
 * fully unit-testable. All inputs are derived server-side at query time;
 * nothing here is ever stored (ADR-2/ADR-5).
 */

export type FeasibilityInput = Pick<
  Goal,
  "targetDate" | "taskCount" | "doneCount" | "remainingOpenEffortMinutes" | "trackedMinutes14d"
>;

export type Feasibility =
  | { state: "done"; daysLeft: number }
  | {
      state: "unknown" | "on-track" | "tight" | "infeasible";
      daysLeft: number;
      requiredPaceMinutesPerDay: number;
      /**
       * null when there is nothing tracked in the window: "unknown" always
       * (no verdict without history), and an overdue goal that is infeasible
       * on the calendar alone — the chip then shows the required pace only.
       */
      actualPaceMinutesPerDay: number | null;
    };

/**
 * Days until the END of the target day, on the LOCAL wall clock — a target
 * date is a human-facing calendar day like streaks and the activity skyline
 * (ADR-21 local-day precedent), not a UTC instant. Lifted out of GoalsPage's
 * days-left chip so the chip and the classifier can never disagree.
 * Today → 1, tomorrow → 2, yesterday → 0 or less.
 */
export function daysUntil(dateStr: string, now: Date = new Date()): number {
  const target = new Date(`${dateStr}T23:59:59`);
  // + 0 normalizes Math.ceil's -0 (target was yesterday) to plain 0.
  return Math.ceil((target.getTime() - now.getTime()) / (24 * 3600 * 1000)) + 0;
}

/** The actual pace averages tracked minutes over this trailing window. */
export const HISTORY_DAYS = 14;

/** required/actual above 1.0 is "tight" up to this ratio, "infeasible" beyond. */
const TIGHT_MAX_RATIO = 1.5;

/**
 * Classify a goal's feasibility, or return null when there is nothing honest
 * to say. Decision table from #60:
 * - no target date, or no tasks at all → null (no feasibility UI)
 * - every task done → "done" (quiet chip, no pace math)
 * - open tasks but no estimated open leaf → null (never claim "on track"
 *   without data)
 * - target day over with estimated open work → "infeasible" regardless of pace
 * - zero tracked history → "unknown": required pace only, no verdict
 * - otherwise required ≤ actual → "on-track", ≤ 1.5 × actual → "tight",
 *   beyond → "infeasible" (boundaries inclusive)
 */
export function feasibility(goal: FeasibilityInput, now: Date = new Date()): Feasibility | null {
  if (!goal.targetDate || goal.taskCount === 0) return null;
  const daysLeft = daysUntil(goal.targetDate, now);
  if (goal.doneCount === goal.taskCount) return { state: "done", daysLeft };

  const remaining = goal.remainingOpenEffortMinutes;
  if (remaining == null || remaining <= 0) return null;

  // Overdue divides by the clamped 1 day — "everything today" is the most
  // optimistic reading left; daysLeft itself stays raw for the caller.
  const requiredPaceMinutesPerDay = remaining / Math.max(1, daysLeft);
  const actualPaceMinutesPerDay =
    goal.trackedMinutes14d > 0 ? goal.trackedMinutes14d / HISTORY_DAYS : null;

  if (daysLeft <= 0) {
    return { state: "infeasible", daysLeft, requiredPaceMinutesPerDay, actualPaceMinutesPerDay };
  }
  if (actualPaceMinutesPerDay === null) {
    return { state: "unknown", daysLeft, requiredPaceMinutesPerDay, actualPaceMinutesPerDay };
  }
  const ratio = requiredPaceMinutesPerDay / actualPaceMinutesPerDay;
  const state = ratio <= 1 ? "on-track" : ratio <= TIGHT_MAX_RATIO ? "tight" : "infeasible";
  return { state, daysLeft, requiredPaceMinutesPerDay, actualPaceMinutesPerDay };
}
