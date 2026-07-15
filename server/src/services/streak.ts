// Pure streak fold (#58, ADR-26 — reshaped after the PR #98 review). No DB,
// no clock — everything the fold needs is passed in, so the logic is
// unit-testable like the draw weights.
//
// Vocabulary:
//   real day    — a local calendar day with >= 1 completion; the only kind
//                 that increments the streak.
//   rest day    — a configured rest WEEKDAY without a completion; neither
//                 breaks nor extends. A completion on a rest weekday counts
//                 +1 like any other day (resting must never beat completing).
//   frozen day  — a missed non-rest day covered by a banked freeze token;
//                 neither breaks nor extends.
//   break       — a missed non-rest day the bank cannot cover; it ends the
//                 run AND expires the bank, so tokens from a dead run never
//                 leak into later ones.
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
  /**
   * Tokens banked at the end of the replay: earned minus consumed, where a
   * break expires the whole bank. Never exceeds FREEZE_BANK_CAP.
   */
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

function nextDay(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  const dt = new Date(y, m - 1, d + 1); // Date normalizes month/year overflow
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(
    dt.getDate(),
  ).padStart(2, "0")}`;
}

/**
 * Deterministic fold, replayed FORWARD from the earliest completion/earn day.
 *
 * The first cut walked BACKWARD from today and assigned specific tokens to
 * specific missed days ("oldest eligible token first"). The PR #98 review
 * showed that shape is wrong twice over: the assignment flipped between
 * reads (a new miss could steal the token that covered an older, already
 * frozen day and retroactively break the run there, even though a feasible
 * assignment covered both), and tokens consumed inside runs the walk never
 * reached were resurrected, so a dead run's bank leaked into every later
 * streak, past the cap. Forward replay fixes both by construction:
 *
 *   - a completion day extends the run (+1);
 *   - an earn adds one token to the bank, CLAMPED to FREEZE_BANK_CAP inside
 *     the fold — re-aggregation under changed rest settings can never
 *     resurrect a third token past the cap;
 *   - a missed non-rest day inside a run consumes one banked token. Earns
 *     are banked only after their day is classified, so a token covers
 *     strictly LATER days — never the day it was earned on or earlier;
 *   - a miss the bank cannot cover is a break: the run dies and the bank
 *     expires with it (tokens earned on or before the break day are gone —
 *     a broken gap consumes nothing, it expires). The bank can therefore
 *     never grow from letting a streak die.
 *
 * The bank is a plain counter — no token identity, no assignment — which
 * makes the cover maximal (any feasible assignment banks the same count)
 * and the replay prefix-stable: a new miss can only affect days after the
 * previous read, never rewrite committed history. Today never breaks and
 * is never freeze-covered while pending.
 */
export function computeStreak(input: StreakInput): StreakState {
  const { completionDays, restWeekdays, today } = input;

  // Earn events per day, replayed chronologically. Future-dated earn rows
  // are organically unreachable (earns are written on completion "today")
  // and are ignored rather than banked sight-unseen.
  const earnsByDay = new Map<string, number>();
  for (const d of input.earnedFreezeDays) {
    if (d <= today) earnsByDay.set(d, (earnsByDay.get(d) ?? 0) + 1);
  }

  // Replay start: the earliest recorded fact. An earn below the earliest
  // completion (possible only after an undo) still has to survive every
  // break between itself and the first run, so the replay must see it.
  let start: string | undefined;
  for (const d of completionDays) if (start === undefined || d < start) start = d;
  for (const d of earnsByDay.keys()) {
    if (d < today && (start === undefined || d < start)) start = d;
  }

  let streak = 0;
  let bank = 0;
  let frozen: string[] = []; // oldest first while replaying; reversed on return
  let rest: string[] = [];

  if (start !== undefined) {
    for (let cursor = start; cursor < today; cursor = nextDay(cursor)) {
      let broke = false;
      if (completionDays.has(cursor)) {
        streak++;
      } else if (restWeekdays.has(weekdayOf(cursor))) {
        if (streak > 0) rest.push(cursor); // a rest day needs a run to belong to
      } else if (streak > 0 && bank > 0) {
        bank--;
        frozen.push(cursor); // bridged but never counted
      } else {
        // Uncoverable miss — the run dies here and the break expires the
        // bank. An earn ON the break day dies with it (it is not strictly
        // after the break), hence `broke` also skips the earn step below.
        broke = true;
        streak = 0;
        bank = 0;
        frozen = [];
        rest = [];
      }
      if (!broke) {
        const earned = earnsByDay.get(cursor);
        if (earned) bank = Math.min(bank + earned, FREEZE_BANK_CAP);
      }
    }
  }

  let todayKind: TodayKind;
  if (completionDays.has(today)) {
    todayKind = "completed"; // a completion on a rest weekday still counts +1
    streak++;
  } else if (restWeekdays.has(weekdayOf(today))) {
    todayKind = "rest";
  } else {
    todayKind = "pending"; // today in progress never breaks and is never freeze-covered
  }
  const earnedToday = earnsByDay.get(today);
  if (earnedToday) bank = Math.min(bank + earnedToday, FREEZE_BANK_CAP);

  return {
    streak,
    todayKind,
    freezesBanked: bank,
    frozenDays: frozen.reverse(),
    restDays: rest.reverse(),
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
