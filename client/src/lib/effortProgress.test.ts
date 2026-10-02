import { describe, expect, it } from "vitest";
import { effortProgress } from "./effortProgress";

describe("effortProgress", () => {
  it("starts at zero completed minutes for an untouched estimated goal", () => {
    expect(effortProgress({ remainingOpenEffortMinutes: 600, totalEffortMinutes: 600 })).toEqual({
      total: 600,
      remaining: 600,
      completed: 0,
      pct: 0,
    });
  });

  it("derives partial progress in the completed direction", () => {
    const progress = effortProgress({
      remainingOpenEffortMinutes: 150,
      totalEffortMinutes: 600,
    });
    expect(progress).toMatchObject({ total: 600, remaining: 150, completed: 450 });
    expect(progress!.pct).toBeCloseTo(0.75);
  });

  it("shows all estimated minutes complete when no estimated work remains open", () => {
    expect(effortProgress({ remainingOpenEffortMinutes: null, totalEffortMinutes: 600 })).toEqual({
      total: 600,
      remaining: 0,
      completed: 600,
      pct: 1,
    });
  });

  it("returns no minute progress for an unestimated goal", () => {
    expect(effortProgress({ remainingOpenEffortMinutes: null, totalEffortMinutes: null })).toBeNull();
    expect(effortProgress({ remainingOpenEffortMinutes: null, totalEffortMinutes: 0 })).toBeNull();
  });

  it("clamps refetch skew before deriving the accessible value and fill", () => {
    expect(effortProgress({ remainingOpenEffortMinutes: 700, totalEffortMinutes: 600 })).toEqual({
      total: 600,
      remaining: 600,
      completed: 0,
      pct: 0,
    });
    expect(effortProgress({ remainingOpenEffortMinutes: -25, totalEffortMinutes: 600 })).toEqual({
      total: 600,
      remaining: 0,
      completed: 600,
      pct: 1,
    });
  });
});
