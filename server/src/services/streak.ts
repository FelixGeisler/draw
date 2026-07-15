// Pure streak walk-back (#58, ADR-26). No DB, no clock — everything the fold
// needs is passed in, so the logic is unit-testable like the draw weights.
//
// Vocabulary:
//   real day    — a local calendar day with >= 1 completion; the only kind
//                 that increments the streak.
//   rest day    — a configured rest WEEKDAY without a completion; neither
//                 breaks nor extends. A completion on a rest weekday counts
//                 +1 like any other day (resting must never beat completing).
//   frozen day  — a missed non-rest day covered by a banked freeze token;
//                 neither breaks nor extends.
//
// The streak number therefore always equals the count of real completion
// days in the unbroken run.

export const FREEZE_BANK_CAP = 2;
export const FREEZE_MILESTONE_DAYS = 7;

export interface StreakInput {
  /** Local calendar days ("YYYY-MM-DD") with at least one completion. */
  completionDays: ReadonlySet<string>;
  /** Rest weekdays, JS getDay convention (0=Sun..6=Sat). Validated to size <= 6. */
  restWeekdays: ReadonlySet<number>;
  /**
   * Milestone days of EARNED freeze tokens (append-only log). Consumption is
   * never stored — it is derived here on every read (ADR-5: log over
   * counters).
   */
  earnedFreezeDays: readonly string[];
  /** Local calendar day "today". Never breaks the streak while pending. */
  today: string;
}

export type TodayKind = "completed" | "pending" | "rest";

export interface StreakState {
  /** Count of real completion days in the unbroken run. */
  streak: number;
  todayKind: TodayKind;
  /** Earned tokens minus derived-consumed tokens. */
  freezesBanked: number;
  /** Days in the surviving run covered by a consumed token, most recent first. */
  frozenDays: string[];
  /** Rest days without a completion inside the surviving run, most recent first. */
  restDays: string[];
}

/** Weekday of a local calendar day — TZ-independent for date parts. */
export function weekdayOf(day: string): number {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d).getDay();
}

function previousDay(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  const dt = new Date(y, m - 1, d - 1); // Date normalizes month/year underflow
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(
    dt.getDate(),
  ).padStart(2, "0")}`;
}

/**
 * Deterministic fold: walk back from today; a missed non-rest day claims the
 * OLDEST unconsumed token whose milestone day lies strictly BEFORE it (a
 * token earned later cannot retroactively protect a day it didn't exist on).
 * Claims stay tentative until the next older real completion day anchors
 * them — a gap that exceeds the bank, or trails past the earliest completion,
 * breaks the streak WITHOUT consuming anything (no tokens are wasted on an
 * already-dead run).
 */
export function computeStreak(input: StreakInput): StreakState {
  const { completionDays, restWeekdays, today } = input;
  const tokens = [...input.earnedFreezeDays].sort(); // oldest milestone first
  const consumed = new Set<number>();

  let streak = 0;
  let todayKind: TodayKind;
  if (completionDays.has(today)) {
    todayKind = "completed"; // a completion on a rest weekday still counts +1
    streak++;
  } else if (restWeekdays.has(weekdayOf(today))) {
    todayKind = "rest";
  } else {
    todayKind = "pending"; // today in progress never breaks and is never freeze-covered
  }

  const frozenDays: string[] = [];
  const restDays: string[] = [];

  // Termination bound: the earliest completion day. With up to 6 rest
  // weekdays almost every day is skippable, so without this bound the walk
  // would never end on a sparse log.
  let earliest: string | undefined;
  for (const d of completionDays) if (earliest === undefined || d < earliest) earliest = d;

  let tentativeFrozen: string[] = [];
  let tentativeRest: string[] = [];
  let tentativeClaims: number[] = [];

  if (earliest !== undefined) {
    for (let cursor = previousDay(today); cursor >= earliest; cursor = previousDay(cursor)) {
      if (completionDays.has(cursor)) {
        streak++;
        for (const i of tentativeClaims) consumed.add(i);
        frozenDays.push(...tentativeFrozen);
        restDays.push(...tentativeRest);
        tentativeClaims = [];
        tentativeFrozen = [];
        tentativeRest = [];
      } else if (restWeekdays.has(weekdayOf(cursor))) {
        tentativeRest.push(cursor);
      } else {
        const idx = tokens.findIndex(
          (t, i) => !consumed.has(i) && !tentativeClaims.includes(i) && t < cursor,
        );
        if (idx === -1) break; // uncoverable gap — run ends, tentative claims discarded
        tentativeClaims.push(idx);
        tentativeFrozen.push(cursor);
      }
    }
  }

  return {
    streak,
    todayKind,
    freezesBanked: tokens.length - consumed.size,
    frozenDays,
    restDays,
  };
}

/**
 * Earn decision for completeTask(): one token per 7-real-day milestone,
 * capped at FREEZE_BANK_CAP banked. Idempotent per milestone — the streak
 * grows at most +1 per calendar day, so a milestone maps to exactly one
 * local day; once that day is on the earn log, complete → reopen → complete
 * again cannot farm a second token (the log is append-only and survives the
 * undo).
 */
export function shouldEarnFreeze(
  state: StreakState,
  earnedFreezeDays: readonly string[],
  today: string,
): boolean {
  return (
    state.streak > 0 &&
    state.streak % FREEZE_MILESTONE_DAYS === 0 &&
    state.freezesBanked < FREEZE_BANK_CAP &&
    !earnedFreezeDays.includes(today)
  );
}
