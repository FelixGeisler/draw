import { describe, expect, it } from "vitest";
import { trophyRarity } from "./trophyRarity";

// Pins the deterministic tier table of issue #62: rarity is a pure function
// of (wasDrawn, impact) — the same facts the XP bonus and ADR-4 already rest
// on. No randomness, nothing stored.
describe("trophyRarity", () => {
  it("gives a drawn impact-5 completion the foil tier", () => {
    expect(trophyRarity({ wasDrawn: 1, impact: 5 })).toBe("foil");
  });

  it("gives a drawn impact-4 completion the silver tier", () => {
    expect(trophyRarity({ wasDrawn: 1, impact: 4 })).toBe("silver");
  });

  it("keeps drawn low-impact completions plain", () => {
    expect(trophyRarity({ wasDrawn: 1, impact: 3 })).toBe("none");
    expect(trophyRarity({ wasDrawn: 1, impact: 2 })).toBe("none");
    expect(trophyRarity({ wasDrawn: 1, impact: 1 })).toBe("none");
  });

  it("keeps not-drawn completions plain regardless of impact", () => {
    expect(trophyRarity({ wasDrawn: 0, impact: 5 })).toBe("none");
    expect(trophyRarity({ wasDrawn: 0, impact: 4 })).toBe("none");
  });

  it("accepts wasDrawn as SQLite 0|1 numbers and as booleans", () => {
    // The gamification payload delivers 0|1 (raw SQLite), the activity
    // payload a boolean — both callers share this helper.
    expect(trophyRarity({ wasDrawn: 1, impact: 5 })).toBe("foil");
    expect(trophyRarity({ wasDrawn: true, impact: 5 })).toBe("foil");
    expect(trophyRarity({ wasDrawn: 0, impact: 5 })).toBe("none");
    expect(trophyRarity({ wasDrawn: false, impact: 5 })).toBe("none");
  });
});
