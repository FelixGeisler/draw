// Flame-state derivation for the gamification header (#58, extracted per the
// PR #98 review): the four-state precedence is client logic worth a unit
// test, and the day math must reuse localDay.ts instead of growing another
// drifting local-day copy (that module's whole purpose).

import { diffDays, localToday } from "./localDay";

export type FlameState = "lit" | "pending" | "rest" | "frozen";

export interface FlameFacts {
  dailyGoalMet: boolean;
  todayKind: "completed" | "pending" | "rest";
  /** Freeze-covered days ("YYYY-MM-DD") of the surviving run, most recent first. */
  frozenDays: string[];
}

export interface FlameView {
  state: FlameState;
  /** The covered day the "frozen" state points at — set iff state is "frozen". */
  recentFreeze?: string;
}

/** A spent freeze stays visible this many days so it never vanishes silently. */
export const FREEZE_VISIBILITY_DAYS = 7;

/**
 * Four honest flame states: rest and frozen days are never presented as
 * completed. The precedence lit > rest > frozen > pending is a product
 * decision: meeting today's goal beats everything (the user acted today, so
 * the flame burns even when a freeze was spent recently), a deliberate rest
 * day beats a spent freeze (nothing was expected today), and a freeze
 * consumed within the last week beats plain pending so a silently spent
 * token stays visible for a while.
 */
export function deriveFlame(facts: FlameFacts, today: string = localToday()): FlameView {
  if (facts.dailyGoalMet) return { state: "lit" };
  if (facts.todayKind === "rest") return { state: "rest" };
  const recentFreeze = facts.frozenDays.find(
    (day) => diffDays(day, today) <= FREEZE_VISIBILITY_DAYS,
  );
  if (recentFreeze !== undefined) return { state: "frozen", recentFreeze };
  return { state: "pending" };
}
