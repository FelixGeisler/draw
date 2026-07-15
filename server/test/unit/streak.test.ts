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

/** Inclusive range of consecutive local days. */
function span(fromOffset: number, toOffset: number, from = WED): string[] {
  const days: string[] = [];
  for (let o = fromOffset; o <= toOffset; o++) days.push(day(o, from));
  return days;
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
        earnedFreezeDays: [day(-3)], // earned inside the run, before the miss
      }),
    );
    expect(s.streak).toBe(3); // day(-2) frozen — bridged but not counted
    expect(s.frozenDays).toEqual([day(-2)]);
    expect(s.freezesBanked).toBe(0);
  });

  it("each covered day consumes exactly one banked token", () => {
    const s = computeStreak(
      input({
        completionDays: new Set([day(-5), day(-3), day(-1), day(0)]),
        earnedFreezeDays: [day(-5), day(-3)],
      }),
    );
    expect(s.streak).toBe(4);
    expect(s.frozenDays).toEqual([day(-2), day(-4)]); // most recent first
    expect(s.freezesBanked).toBe(0);
  });

  it("a token cannot cover a day before it was earned — or its own earn day", () => {
    const s = computeStreak(
      input({
        completionDays: new Set([day(-3), day(-1), day(0)]),
        earnedFreezeDays: [day(-2)], // earned ON the missed day — not before it
      }),
    );
    expect(s.streak).toBe(2); // run ends above the gap
    // The uncovered miss is a break, and a break expires everything earned
    // on or before it — the same-day token dies with the run it belonged to.
    expect(s.freezesBanked).toBe(0);
    expect(s.frozenDays).toEqual([]);
  });

  it("a gap larger than the bank breaks the streak and the break expires the bank", () => {
    const s = computeStreak(
      input({
        completionDays: new Set([day(-5), day(-4), day(-1), day(0)]),
        earnedFreezeDays: [day(-4)], // gap of 2 (day -3, -2), only 1 token
      }),
    );
    expect(s.streak).toBe(2);
    // A broken gap consumes nothing — it expires: the pre-gap token is gone
    // (Duolingo-style), it does NOT survive to shield some future run.
    expect(s.freezesBanked).toBe(0);
    expect(s.frozenDays).toEqual([]);
  });

  it("rest days inside a gap reduce the tokens the gap needs", () => {
    const weekend = new Set([0, 6]);
    // Fri -5 completed (earning a token), Sat/Sun rest, Mon -2 missed
    // (frozen), Tue -1 completed.
    const s = computeStreak(
      input({
        completionDays: new Set([day(-5), day(-1), day(0)]),
        restWeekdays: weekend,
        earnedFreezeDays: [day(-5)],
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
        earnedFreezeDays: [day(-2)],
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
        earnedFreezeDays: [day(-3)],
      }),
    );
    expect(s.streak).toBe(2); // yesterday frozen, run anchored at day(-2)
    expect(s.frozenDays).toEqual([day(-1)]);
    expect(s.freezesBanked).toBe(0);
  });
});

describe("computeStreak — coverage is maximal and stable across reads (PR #98 review, finding 1)", () => {
  // The trace that broke the backward walk: two 1-day gaps, one token earned
  // before each (milestones 7 and 14). The old "oldest eligible token" claim
  // handed the NEWER gap the OLDER token, starving the more constrained
  // older gap and retroactively breaking the run at a previously-frozen day.
  const completions = new Set([
    ...span(0, 9, "2025-12-26"), // Dec 26 – Jan 4 (milestone 7 → token on Jan 1)
    ...span(0, 8, "2026-01-06"), // Jan 6 – Jan 14 (milestone 14 → token on Jan 9)
    "2026-01-16",
  ]);
  const earns = ["2026-01-01", "2026-01-09"];

  it("the streak survives whenever the bank feasibly covers every gap", () => {
    const s = computeStreak({
      completionDays: completions,
      restWeekdays: new Set(),
      earnedFreezeDays: earns,
      today: "2026-01-16",
    });
    expect(s.streak).toBe(20); // NOT 10 — one miss must never re-break Jan 5
    expect(s.freezesBanked).toBe(0);
    expect(s.frozenDays).toEqual(["2026-01-15", "2026-01-05"]);
  });

  it("a later read preserves an earlier read's coverage (prefix-stable)", () => {
    // Same history read on Jan 14, before the second gap existed.
    const jan14 = computeStreak({
      completionDays: new Set([...span(0, 9, "2025-12-26"), ...span(0, 8, "2026-01-06")]),
      restWeekdays: new Set(),
      earnedFreezeDays: earns,
      today: "2026-01-14",
    });
    expect(jan14.streak).toBe(19);
    expect(jan14.freezesBanked).toBe(1);
    expect(jan14.frozenDays).toEqual(["2026-01-05"]);
    // The Jan 16 read above still shows Jan 5 frozen — committed coverage is
    // never silently rewritten by later misses.
  });
});

describe("computeStreak — a break expires the bank (PR #98 review, finding 2)", () => {
  it("historical earn rows from before a break never resurrect the bank", () => {
    // The review's verified repro: three earn rows on record, fresh start
    // today. The old fold reported freezesBanked: 3 with a cap of 2.
    const s = computeStreak({
      completionDays: new Set(["2026-03-10"]),
      restWeekdays: new Set(),
      earnedFreezeDays: ["2026-01-01", "2026-01-09", "2026-01-20"],
      today: "2026-03-10",
    });
    expect(s.streak).toBe(1);
    expect(s.freezesBanked).toBe(0); // expired by the gap — no zombie tokens
  });

  it("letting a streak die empties the bank instead of growing it", () => {
    // Organic history: 21 real days earn three tokens (milestones 7/14/21,
    // one covered miss in between), then a two-week break kills the run.
    const completions = new Set([
      ...span(-36, -30), // 7 real days → earn on day(-30)
      // day(-29) missed — covered by the first token
      ...span(-28, -22), // streak 8..14 → earn on day(-22)
      ...span(-21, -15), // streak 15..21 → earn on day(-15)
      // day(-14)..day(-1): 14 misses — 2 frozen, then the run breaks
      day(0), // fresh start today
    ]);
    const s = computeStreak(
      input({
        completionDays: completions,
        earnedFreezeDays: [day(-30), day(-22), day(-15)],
      }),
    );
    expect(s.streak).toBe(1);
    expect(s.freezesBanked).toBe(0); // the break expired the whole bank
    expect(s.frozenDays).toEqual([]); // nothing from the dead run survives
    expect(s.restDays).toEqual([]);
  });

  it("a rest-setting change that un-consumes a claim cannot push the bank past the cap", () => {
    // Organic run: earn on D7, miss D8 (covered), earns on D15 and D22 —
    // every earn passed the write-time gate with banked < 2.
    const completions = new Set([...span(-22, -16), ...span(-14, -1)]);
    const earns = [day(-16), day(-8), day(-1)];

    const before = computeStreak(
      input({ completionDays: completions, earnedFreezeDays: earns }),
    );
    expect(before.streak).toBe(21);
    expect(before.frozenDays).toEqual([day(-15)]);
    expect(before.freezesBanked).toBe(2);

    // Marking the missed day's weekday as a rest day un-consumes the claim.
    // The replayed bank must clamp at the cap — not resurrect a third token.
    const after = computeStreak(
      input({
        completionDays: completions,
        earnedFreezeDays: earns,
        restWeekdays: new Set([weekdayOf(day(-15))]),
      }),
    );
    expect(after.streak).toBe(21);
    expect(after.frozenDays).toEqual([]);
    expect(after.restDays).toEqual([day(-15)]);
    expect(after.freezesBanked).toBe(2); // NOT 3
    expect(after.freezesBanked).toBeLessThanOrEqual(FREEZE_BANK_CAP);
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
