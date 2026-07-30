import { describe, expect, it } from "vitest";
import { bossBar } from "./bossBar";

// Boss battles (#229): the HP derivation. maxHp comes from ALL non-archived
// leaves, hp from the open ones — both server-derived; this lib only has to
// combine them honestly.

describe("bossBar", () => {
  it("full HP for an untouched goal", () => {
    const bar = bossBar({ remainingOpenEffortMinutes: 600, totalEffortMinutes: 600 }, "on-track");
    expect(bar).toEqual({ maxHp: 600, hp: 600, pct: 1, damage: 0, enraged: false });
  });

  it("completions deal damage — hp is what still stands", () => {
    const bar = bossBar({ remainingOpenEffortMinutes: 150, totalEffortMinutes: 600 }, "tight");
    expect(bar).toMatchObject({ hp: 150, damage: 450 });
    expect(bar!.pct).toBeCloseTo(0.25);
  });

  it("a downed boss: every estimated leaf done reads as hp 0, never negative", () => {
    // remaining is NULL when no open leaf is estimated — the boss is downed,
    // waiting for the goal to be marked achieved.
    const bar = bossBar({ remainingOpenEffortMinutes: null, totalEffortMinutes: 600 }, "done");
    expect(bar).toMatchObject({ hp: 0, pct: 0, damage: 600 });
  });

  it("no estimated leaves — no bar; the count-based progress bar stays", () => {
    expect(bossBar({ remainingOpenEffortMinutes: null, totalEffortMinutes: null }, "unknown")).toBeNull();
    expect(bossBar({ remainingOpenEffortMinutes: null, totalEffortMinutes: 0 }, "unknown")).toBeNull();
  });

  it("enrage is exactly the feasibility chip's infeasible verdict", () => {
    const goal = { remainingOpenEffortMinutes: 500, totalEffortMinutes: 600 };
    expect(bossBar(goal, "infeasible")!.enraged).toBe(true);
    for (const f of ["on-track", "tight", "unknown", "done"] as const) {
      expect(bossBar(goal, f)!.enraged).toBe(false);
    }
  });

  it("clamps hp to maxHp — a mid-refetch payload can never overflow the bar", () => {
    const bar = bossBar({ remainingOpenEffortMinutes: 700, totalEffortMinutes: 600 }, "on-track");
    expect(bar).toMatchObject({ hp: 600, pct: 1 });
  });
});
