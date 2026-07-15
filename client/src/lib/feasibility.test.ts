import { describe, expect, it } from "vitest";
import { daysUntil, feasibility, type FeasibilityInput } from "./feasibility";

// Pins the #60 decision table. NOW sits exactly at an end-of-day so the
// distance to the target's 23:59:59 is a whole number of days and the
// required-pace divisions come out exact.
const NOW = new Date("2026-07-15T23:59:59");

// Defaults: 10 days left, 100 min open effort → required 10 min/day;
// 140 min tracked over the 14-day window → actual 10 min/day (ratio 1.0).
function goal(over: Partial<FeasibilityInput> = {}): FeasibilityInput {
  return {
    targetDate: "2026-07-25",
    taskCount: 3,
    doneCount: 1,
    remainingOpenEffortMinutes: 100,
    trackedMinutes14d: 140,
    ...over,
  };
}

describe("daysUntil", () => {
  // Mid-day now: the chip counts to the END of the target day (local wall
  // clock, ADR-21 precedent), so "due today" still reads as 1 day left.
  const midday = new Date("2026-07-15T12:00:00");

  it("counts to the end of the target day: today is 1, tomorrow 2", () => {
    expect(daysUntil("2026-07-15", midday)).toBe(1);
    expect(daysUntil("2026-07-16", midday)).toBe(2);
  });

  it("is 0 for yesterday and negative further back", () => {
    expect(daysUntil("2026-07-14", midday)).toBe(0);
    expect(daysUntil("2026-07-10", midday)).toBe(-4);
  });
});

describe("feasibility — no-signal cases return null", () => {
  it("without a target date there is no feasibility at all", () => {
    expect(feasibility(goal({ targetDate: null }), NOW)).toBeNull();
  });

  it("a goal without any tasks has nothing to burn down", () => {
    expect(feasibility(goal({ taskCount: 0, doneCount: 0 }), NOW)).toBeNull();
  });

  it("open tasks but no estimated open leaf never claims a verdict", () => {
    expect(feasibility(goal({ remainingOpenEffortMinutes: null }), NOW)).toBeNull();
    expect(feasibility(goal({ remainingOpenEffortMinutes: 0 }), NOW)).toBeNull();
  });
});

describe("feasibility — done and unknown", () => {
  it("all tasks done is a quiet done state without pace math", () => {
    expect(feasibility(goal({ taskCount: 3, doneCount: 3 }), NOW)).toEqual({
      state: "done",
      daysLeft: 10,
    });
  });

  it("done wins even when the leaf sum is empty", () => {
    expect(
      feasibility(goal({ taskCount: 2, doneCount: 2, remainingOpenEffortMinutes: null }), NOW),
    ).toEqual({ state: "done", daysLeft: 10 });
  });

  it("zero history yields the required pace only — no verdict, no actual pace", () => {
    expect(feasibility(goal({ trackedMinutes14d: 0 }), NOW)).toEqual({
      state: "unknown",
      daysLeft: 10,
      requiredPaceMinutesPerDay: 10,
      actualPaceMinutesPerDay: null,
    });
  });
});

describe("feasibility — verdict thresholds (boundaries inclusive)", () => {
  it("required below actual is on track", () => {
    const f = feasibility(goal({ remainingOpenEffortMinutes: 50 }), NOW);
    expect(f).toEqual({
      state: "on-track",
      daysLeft: 10,
      requiredPaceMinutesPerDay: 5,
      actualPaceMinutesPerDay: 10,
    });
  });

  it("ratio exactly 1.0 still counts as on track", () => {
    expect(feasibility(goal(), NOW)?.state).toBe("on-track");
  });

  it("just above 1.0 is tight", () => {
    expect(feasibility(goal({ remainingOpenEffortMinutes: 101 }), NOW)?.state).toBe("tight");
  });

  it("ratio exactly 1.5 still counts as tight", () => {
    const f = feasibility(goal({ remainingOpenEffortMinutes: 150 }), NOW);
    expect(f?.state).toBe("tight");
    expect(f && "requiredPaceMinutesPerDay" in f && f.requiredPaceMinutesPerDay).toBe(15);
  });

  it("above 1.5 is infeasible", () => {
    expect(feasibility(goal({ remainingOpenEffortMinutes: 151 }), NOW)?.state).toBe("infeasible");
  });

  it("returns unrounded paces — display rounding is the chip's job", () => {
    const f = feasibility(goal({ targetDate: "2026-07-18" }), NOW); // 3 days left
    expect(f && "requiredPaceMinutesPerDay" in f && f.requiredPaceMinutesPerDay).toBeCloseTo(
      100 / 3,
    );
  });
});

describe("feasibility — overdue and the daysLeft clamp", () => {
  it("a past target with open estimated work is infeasible regardless of pace", () => {
    // 5 days overdue; actual pace 100 min/day would beat any finite required
    // pace, but the calendar has already decided.
    const f = feasibility(
      goal({ targetDate: "2026-07-10", trackedMinutes14d: 1400 }),
      NOW,
    );
    expect(f).toEqual({
      state: "infeasible",
      daysLeft: -5,
      // Clamped division: everything in one (already gone) day.
      requiredPaceMinutesPerDay: 100,
      actualPaceMinutesPerDay: 100,
    });
  });

  it("overdue with zero history is infeasible, not unknown", () => {
    const f = feasibility(goal({ targetDate: "2026-07-10", trackedMinutes14d: 0 }), NOW);
    expect(f?.state).toBe("infeasible");
    expect(f && "actualPaceMinutesPerDay" in f && f.actualPaceMinutesPerDay).toBeNull();
  });

  it("due today divides by the single remaining day", () => {
    const f = feasibility(goal({ targetDate: "2026-07-16" }), NOW); // daysLeft 1
    expect(f && "requiredPaceMinutesPerDay" in f && f.requiredPaceMinutesPerDay).toBe(100);
    expect(f?.state).toBe("infeasible"); // 100 needed vs 10 actual
  });
});
