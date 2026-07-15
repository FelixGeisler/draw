import { describe, expect, it } from "vitest";
import {
  computeStreak,
  FREEZE_BANK_CAP,
  shouldEarnFreeze,
  weekdayOf,
  type StreakInput,
} from "../../src/services/streak.js";

// Fixed local days with known weekdays (TZ-independent for date parts):
// 2026-07-15 is a Wednesday, 2026-07-11/12 the surrounding Sat/Sun.
const WED = "2026-07-15";

function day(offset: number, from = WED): string {
  const [y, m, d] = from.split("-").map(Number);
  const dt = new Date(y, m - 1, d + offset);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(
    dt.getDate(),
  ).padStart(2, "0")}`;
}

function input(partial: Partial<StreakInput>): StreakInput {
  return {
    completionDays: new Set(),
    restWeekdays: new Set(),
    earnedFreezeDays: [],
    today: WED,
    ...partial,
  };
}

describe("computeStreak — plain streaks (empty config matches pre-#58 behavior)", () => {
  it("returns 0 with no completions and today pending", () => {
    expect(computeStreak(input({}))).toMatchObject({
      streak: 0,
      todayKind: "pending",
      freezesBanked: 0,
      frozenDays: [],
      restDays: [],
    });
  });

  it("counts consecutive days; today counts if present", () => {
    const s = computeStreak(
      input({ completionDays: new Set([day(-2), day(-1), day(0)]) }),
    );
    expect(s.streak).toBe(3);
    expect(s.todayKind).toBe("completed");
  });

  it("today still pending does not break the run", () => {
    const s = computeStreak(input({ completionDays: new Set([day(-2), day(-1)]) }));
    expect(s.streak).toBe(2);
    expect(s.todayKind).toBe("pending");
  });

  it("a plain gap breaks the streak", () => {
    const s = computeStreak(input({ completionDays: new Set([day(-3), day(-1)]) }));
    expect(s.streak).toBe(1); // only yesterday — day(-2) missed, day(-3) unreachable
  });
});

describe("computeStreak — rest weekdays", () => {
  const weekend = new Set([0, 6]); // Sun, Sat

  it("a rest weekday without a completion neither breaks nor extends", () => {
    // Fri -5, Sat -4 (rest, missed), Sun -3 (rest, missed), Mon -2, Tue -1
    const s = computeStreak(
      input({
        completionDays: new Set([day(-5), day(-2), day(-1)]),
        restWeekdays: weekend,
      }),
    );
    expect(s.streak).toBe(3); // real days only — the weekend adds nothing
    expect(s.restDays).toEqual([day(-3), day(-4)]); // most recent first
    expect(s.frozenDays).toEqual([]);
  });

  it("a completion on a rest weekday counts +1 like any other day", () => {
    // Sat -4 completed although Sat is a rest day.
    const s = computeStreak(
      input({
        completionDays: new Set([day(-5), day(-4), day(-2), day(-1)]),
        restWeekdays: weekend,
      }),
    );
    expect(s.streak).toBe(4);
    expect(s.restDays).toEqual([day(-3)]); // only the actually-resting Sunday
  });

  it("today on a rest weekday without a completion reports todayKind rest", () => {
    const saturday = day(-4); // 2026-07-11
    expect(weekdayOf(saturday)).toBe(6);
    const s = computeStreak(
      input({
        completionDays: new Set([day(-1, saturday)]),
        restWeekdays: weekend,
        today: saturday,
      }),
    );
    expect(s.todayKind).toBe("rest");
    expect(s.streak).toBe(1); // Friday's completion still anchors the run
  });

  it("rest days trailing below the earliest completion are not part of the run", () => {
    // Only today completed; yesterday was a rest day but nothing anchors it.
    const sunday = day(-3);
    const s = computeStreak(
      input({ completionDays: new Set([day(0, sunday)]), restWeekdays: weekend, today: sunday }),
    );
    expect(s.streak).toBe(1);
    expect(s.restDays).toEqual([]);
  });

  it("terminates with 6 of 7 weekdays as rest, bounded by the earliest completion", () => {
    const onlyWednesdays = new Set([0, 1, 2, 4, 5, 6]); // everything but Wed
    const completions = new Set([day(-28), day(-21), day(-14), day(-7), day(0)]);
    const s = computeStreak(
      input({ completionDays: completions, restWeekdays: onlyWednesdays }),
    );
    expect(s.streak).toBe(5); // five real Wednesdays, 24 rest days in between
    expect(s.restDays.length).toBe(24);
  });
});

describe("computeStreak — freeze consumption", () => {
  it("a banked token covers a missed non-rest day; covered days do not extend", () => {
    const s = computeStreak(
      input({
        completionDays: new Set([day(-3), day(-1), day(0)]),
        earnedFreezeDays: [day(-10)],
      }),
    );
    expect(s.streak).toBe(3); // day(-2) frozen — bridged but not counted
    expect(s.frozenDays).toEqual([day(-2)]);
    expect(s.freezesBanked).toBe(0);
  });

  it("consumes the oldest token first", () => {
    const s = computeStreak(
      input({
        completionDays: new Set([day(-3), day(-1), day(0)]),
        earnedFreezeDays: [day(-8), day(-10)],
      }),
    );
    expect(s.freezesBanked).toBe(1);
    expect(s.frozenDays).toEqual([day(-2)]);
    // The surviving token is the newer one: a further missed day would still
    // be coverable, proving day(-10) was the one consumed.
    const deeper = computeStreak(
      input({
        completionDays: new Set([day(-5), day(-3), day(-1), day(0)]),
        earnedFreezeDays: [day(-8), day(-10)],
      }),
    );
    expect(deeper.streak).toBe(4);
    expect(deeper.frozenDays).toEqual([day(-2), day(-4)]);
    expect(deeper.freezesBanked).toBe(0);
  });

  it("a token cannot cover a day before it was earned", () => {
    const s = computeStreak(
      input({
        completionDays: new Set([day(-3), day(-1), day(0)]),
        earnedFreezeDays: [day(-2)], // earned ON the missed day — not before it
      }),
    );
    expect(s.streak).toBe(2); // run ends above the gap
    expect(s.freezesBanked).toBe(1); // nothing consumed on a dead run
    expect(s.frozenDays).toEqual([]);
  });

  it("a gap larger than the bank breaks the streak and consumes nothing", () => {
    const s = computeStreak(
      input({
        completionDays: new Set([day(-4), day(-1), day(0)]),
        earnedFreezeDays: [day(-10)], // gap of 2 (day -2, -3), only 1 token
      }),
    );
    expect(s.streak).toBe(2);
    expect(s.freezesBanked).toBe(1); // untouched — not wasted on a dead streak
    expect(s.frozenDays).toEqual([]);
  });

  it("rest days inside a gap reduce the tokens the gap needs", () => {
    const weekend = new Set([0, 6]);
    // Fri -5 completed, Sat/Sun rest, Mon -2 missed (frozen), Tue -1 completed.
    const s = computeStreak(
      input({
        completionDays: new Set([day(-5), day(-1), day(0)]),
        restWeekdays: weekend,
        earnedFreezeDays: [day(-10)],
      }),
    );
    expect(s.streak).toBe(3);
    expect(s.frozenDays).toEqual([day(-2)]);
    expect(s.restDays).toEqual([day(-3), day(-4)]);
    expect(s.freezesBanked).toBe(0);
  });

  it("today pending is never freeze-covered", () => {
    const s = computeStreak(
      input({
        completionDays: new Set([day(-2), day(-1)]),
        earnedFreezeDays: [day(-10)],
      }),
    );
    expect(s.todayKind).toBe("pending");
    expect(s.streak).toBe(2);
    expect(s.freezesBanked).toBe(1); // today consumed nothing
    expect(s.frozenDays).toEqual([]);
  });

  it("a frozen gap directly below today survives while today is pending", () => {
    const s = computeStreak(
      input({
        completionDays: new Set([day(-3), day(-2)]),
        earnedFreezeDays: [day(-10)],
      }),
    );
    expect(s.streak).toBe(2); // yesterday frozen, run anchored at day(-2)
    expect(s.frozenDays).toEqual([day(-1)]);
    expect(s.freezesBanked).toBe(0);
  });
});

describe("shouldEarnFreeze — milestone earn decision", () => {
  const state = (streak: number, banked: number) => ({
    streak,
    todayKind: "completed" as const,
    freezesBanked: banked,
    frozenDays: [],
    restDays: [],
  });

  it("earns exactly on multiples of 7 real days", () => {
    expect(shouldEarnFreeze(state(6, 0), [], WED)).toBe(false);
    expect(shouldEarnFreeze(state(7, 0), [], WED)).toBe(true);
    expect(shouldEarnFreeze(state(8, 0), [], WED)).toBe(false);
    expect(shouldEarnFreeze(state(14, 1), [], WED)).toBe(true);
    expect(shouldEarnFreeze(state(0, 0), [], WED)).toBe(false);
  });

  it("respects the bank cap", () => {
    expect(shouldEarnFreeze(state(7, FREEZE_BANK_CAP), [], WED)).toBe(false);
    expect(shouldEarnFreeze(state(7, FREEZE_BANK_CAP - 1), [], WED)).toBe(true);
  });

  it("is idempotent per milestone day — undo/redo cannot farm", () => {
    // First completion of the 7th day earns; the earn row records today.
    expect(shouldEarnFreeze(state(7, 0), [], WED)).toBe(true);
    // Reopen deletes the completion but the earn log is append-only; the
    // re-completion crosses 7 again on the SAME day and must not earn.
    expect(shouldEarnFreeze(state(7, 1), [WED], WED)).toBe(false);
    // A later milestone on a different day earns normally.
    expect(shouldEarnFreeze(state(14, 1), [WED], day(7))).toBe(true);
  });
});
