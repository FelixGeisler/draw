import { describe, expect, it } from "vitest";
import { deepestStreak, wrappedStats, type WrappedInputs } from "./wrapped";
import type { ActivityDay } from "../hooks/useActivity";

// Draw Wrapped (#234): a calendar year folded from payloads the app already
// holds. Fixed dates throughout — no wall clock (#219 rules).

function day(
  date: string,
  totals: Partial<ActivityDay["totals"]> = {},
  cards: { impact: number; wasDrawn: boolean }[] = [],
): ActivityDay {
  return {
    date,
    totals: { started: 0, completed: 0, minutes: 0, xp: 0, ...totals },
    cards: cards.map((c, i) => ({
      taskId: i,
      title: `card ${i}`,
      impact: c.impact,
      minutes: 0,
      completed: true,
      wasDrawn: c.wasDrawn,
    })),
  } as unknown as ActivityDay;
}

function inputs(overrides: Partial<WrappedInputs> = {}): WrappedInputs {
  return {
    year: 2026,
    days: [],
    frozenDays: [],
    restWeekdays: [],
    achievements: [],
    goals: [],
    ...overrides,
  };
}

describe("deepestStreak", () => {
  it("counts completion days only, but freezes and rest weekdays bridge gaps", () => {
    // Mon 2026-07-27 .. Fri 2026-07-31; Wed frozen, weekend = rest.
    const completions = ["2026-07-27", "2026-07-28", "2026-07-30", "2026-07-31", "2026-08-03"];
    // Wed 29th frozen; Sat/Sun (Aug 1-2) rest → one unbroken run of 5.
    expect(deepestStreak(completions, ["2026-07-29"], [0, 6])).toBe(5);
    // Without the freeze the run splits: 2 then 3 (Thu..Fri..Mon over rest).
    expect(deepestStreak(completions, [], [0, 6])).toBe(3);
    // Without rest days the weekend breaks it too.
    expect(deepestStreak(completions, ["2026-07-29"], [])).toBe(4);
  });

  it("handles the trivial shapes", () => {
    expect(deepestStreak([], [], [])).toBe(0);
    expect(deepestStreak(["2026-01-01"], [], [])).toBe(1);
  });
});

describe("wrappedStats", () => {
  it("folds the year and ignores days outside it", () => {
    const stats = wrappedStats(
      inputs({
        days: [
          day("2026-03-01", { completed: 3, minutes: 90, xp: 100 }, [{ impact: 5, wasDrawn: true }]),
          day("2026-06-10", { completed: 2, minutes: 45, xp: 60 }),
          day("2025-12-31", { completed: 99, minutes: 999, xp: 999 }), // last year — out
        ],
        achievements: [
          { title: "Centurion", emoji: "💯", unlockedAt: "2026-03-02T10:00:00.000Z", rarity: "super-rare" },
          { title: "First draw", emoji: "🃏", unlockedAt: "2026-01-01T09:00:00.000Z", rarity: "common" },
          { title: "Unstoppable", emoji: "🌋", unlockedAt: "2025-11-11T09:00:00.000Z", rarity: "ultra-rare" }, // out
          { title: "Locked", emoji: "🔒", unlockedAt: null, rarity: "secret-rare" },
        ],
        goals: [
          { title: "Ship 1.0", status: "achieved", resolvedAt: "2026-05-01T12:00:00.000Z", doneCount: 40 },
          { title: "Tiny", status: "achieved", resolvedAt: "2026-02-01T12:00:00.000Z", doneCount: 3 },
          { title: "Dropped", status: "dropped", resolvedAt: "2026-04-01T12:00:00.000Z", doneCount: 99 },
        ],
      }),
    );
    expect(stats).toMatchObject({
      year: 2026,
      cardsCompleted: 5,
      hoursTracked: 2, // 135 min floors to 2
      xpEarned: 160,
      holos: 1,
      rarestAchievement: { title: "Centurion", rarity: "super-rare" },
      biggestGoal: { title: "Ship 1.0", doneCount: 40 },
    });
  });

  it("returns null for a year with no activity", () => {
    expect(wrappedStats(inputs())).toBeNull();
    expect(wrappedStats(inputs({ days: [day("2025-06-01", { completed: 5 })] }))).toBeNull();
  });

  it("a year of tracking without completions still wraps", () => {
    const stats = wrappedStats(inputs({ days: [day("2026-01-10", { minutes: 120 })] }));
    expect(stats).toMatchObject({ cardsCompleted: 0, hoursTracked: 2, deepestStreak: 0 });
  });
});
