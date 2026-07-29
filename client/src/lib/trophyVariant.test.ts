import { describe, expect, it } from "vitest";
import { TROPHY_VARIANTS, trophyVariant } from "./trophyVariant";

// Trophy variants (#204): the design is derived from the goal id, never
// stored. What these pin is not the arithmetic but its promises: stability
// (the same goal can never change trophies), adjacent variety (sequential
// ids never collide), and the cup staying in the rotation.

describe("trophyVariant", () => {
  it("is pure: the same goal id always yields the same design", () => {
    for (const id of [1, 2, 7, 42, 9001]) {
      expect(trophyVariant(id)).toBe(trophyVariant(id));
    }
  });

  it("gives sequential ids different designs — neighbors on the shelf never match", () => {
    // Goal ids are assigned sequentially, so goals achieved near each other
    // in time sit near each other on the shelf. Any two ids closer than the
    // rotation length must differ.
    const n = TROPHY_VARIANTS.length;
    for (let id = 1; id <= 40; id++) {
      for (let gap = 1; gap < n; gap++) {
        expect(trophyVariant(id)).not.toBe(trophyVariant(id + gap));
      }
    }
  });

  it("cycles after exactly one full rotation", () => {
    expect(trophyVariant(3)).toBe(trophyVariant(3 + TROPHY_VARIANTS.length));
  });

  it("keeps the classic cup in the rotation", () => {
    // The empty-state ghost shows the cup, so the cup must remain earnable —
    // and it is pinned to index 0 (see the order warning in trophyVariant.ts).
    expect(TROPHY_VARIANTS[0]).toBe("cup");
    expect(trophyVariant(TROPHY_VARIANTS.length)).toBe("cup");
  });

  it("covers every design across one id run", () => {
    const seen = new Set(
      Array.from({ length: TROPHY_VARIANTS.length }, (_, i) => trophyVariant(i + 1)),
    );
    expect(seen.size).toBe(TROPHY_VARIANTS.length);
  });

  it("tolerates ids a backup import owes us nothing about", () => {
    // Any integer-ish input must land on a real design, never undefined.
    for (const id of [0, -3, 2.9, -7.5]) {
      expect(TROPHY_VARIANTS).toContain(trophyVariant(id));
    }
  });
});
