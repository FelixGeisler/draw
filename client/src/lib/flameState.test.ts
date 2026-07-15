import { describe, expect, it } from "vitest";
import { deriveFlame, type FlameFacts } from "./flameState";
import { addDays } from "./localDay";

const TODAY = "2026-07-15";

function facts(partial: Partial<FlameFacts>): FlameFacts {
  return { dailyGoalMet: false, todayKind: "pending", frozenDays: [], ...partial };
}

describe("deriveFlame — four honest flame states (#58)", () => {
  it("defaults to pending with nothing going on", () => {
    expect(deriveFlame(facts({}), TODAY)).toEqual({ state: "pending" });
  });

  it("lit when today's goal is met", () => {
    expect(deriveFlame(facts({ dailyGoalMet: true, todayKind: "completed" }), TODAY)).toEqual({
      state: "lit",
    });
  });

  it("lit beats rest and frozen — completing always wins", () => {
    const view = deriveFlame(
      facts({ dailyGoalMet: true, todayKind: "rest", frozenDays: [addDays(TODAY, -1)] }),
      TODAY,
    );
    expect(view).toEqual({ state: "lit" });
  });

  it("rest beats frozen — nothing was expected today", () => {
    const view = deriveFlame(
      facts({ todayKind: "rest", frozenDays: [addDays(TODAY, -1)] }),
      TODAY,
    );
    expect(view).toEqual({ state: "rest" });
  });

  it("a freeze spent within the last week shows as frozen with that day", () => {
    const covered = addDays(TODAY, -3);
    expect(deriveFlame(facts({ frozenDays: [covered] }), TODAY)).toEqual({
      state: "frozen",
      recentFreeze: covered,
    });
  });

  it("points at the most recent covered day (frozenDays are most recent first)", () => {
    const newer = addDays(TODAY, -2);
    const older = addDays(TODAY, -5);
    expect(deriveFlame(facts({ frozenDays: [newer, older] }), TODAY).recentFreeze).toBe(newer);
  });

  it("a freeze exactly seven days ago still shows; an eighth-day one does not", () => {
    const boundary = addDays(TODAY, -7);
    expect(deriveFlame(facts({ frozenDays: [boundary] }), TODAY)).toEqual({
      state: "frozen",
      recentFreeze: boundary,
    });
    expect(deriveFlame(facts({ frozenDays: [addDays(TODAY, -8)] }), TODAY)).toEqual({
      state: "pending",
    });
  });
});
