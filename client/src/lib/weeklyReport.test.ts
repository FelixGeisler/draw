import { describe, expect, it } from "vitest";
import { weeklyReport, weekStartOf } from "./weeklyReport";
import type { ActivityDay } from "../hooks/useActivity";

// The weekly run report (#233, ADR-65): Monday-first local weeks folded from
// the activity payload. Everything here is date-string math over a fixed
// "today" — no wall clock, so the suite is green at any hour (#219 lesson).

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

describe("weekStartOf", () => {
  it("finds Monday for every weekday, Monday-first like the History calendar", () => {
    expect(weekStartOf("2026-07-30")).toBe("2026-07-27"); // Thursday → Monday
    expect(weekStartOf("2026-07-27")).toBe("2026-07-27"); // Monday is its own start
    expect(weekStartOf("2026-08-02")).toBe("2026-07-27"); // Sunday closes the week
    expect(weekStartOf("2026-08-03")).toBe("2026-08-03"); // next Monday starts fresh
  });
});

describe("weeklyReport", () => {
  const TODAY = "2026-07-30"; // Thursday; week = Jul 27 … Aug 2

  it("folds this week's totals, rarities and best day", () => {
    const report = weeklyReport(
      [
        day("2026-07-27", { completed: 2, minutes: 50, xp: 60 }),
        day("2026-07-29", { completed: 4, minutes: 30, xp: 90 }, [
          { impact: 5, wasDrawn: true }, // holo
          { impact: 4, wasDrawn: true }, // silver
          { impact: 5, wasDrawn: false }, // plain — not drawn
        ]),
        day("2026-08-03", { completed: 9, minutes: 900, xp: 1 }), // NEXT week — out
      ],
      TODAY,
    );
    expect(report).toMatchObject({
      weekStart: "2026-07-27",
      completions: 6,
      minutes: 80,
      xp: 150,
      holos: 1,
      silvers: 1,
      bestDay: { date: "2026-07-29", completions: 4 },
    });
  });

  it("deltas compare against exactly the seven days before the week", () => {
    const report = weeklyReport(
      [
        day("2026-07-22", { completed: 5, minutes: 100 }), // last week (Wed)
        day("2026-07-20", { completed: 1, minutes: 20 }), // last week (Mon)
        day("2026-07-19", { completed: 50, minutes: 999 }), // TWO weeks back — out
        day("2026-07-28", { completed: 4, minutes: 60 }), // this week
      ],
      TODAY,
    );
    expect(report).toMatchObject({ deltaCompletions: 4 - 6, deltaMinutes: 60 - 120 });
  });

  it("returns null for a week with no activity — a recap of nothing is noise", () => {
    expect(weeklyReport([], TODAY)).toBeNull();
    expect(
      weeklyReport([day("2026-07-20", { completed: 3, minutes: 30 })], TODAY),
    ).toBeNull(); // only LAST week has activity
  });

  it("a minutes-only week still reports (worked, finished nothing)", () => {
    const report = weeklyReport([day("2026-07-28", { minutes: 45 })], TODAY);
    expect(report).toMatchObject({ completions: 0, minutes: 45, bestDay: null });
  });
});
