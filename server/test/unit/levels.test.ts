import { describe, expect, it } from "vitest";
import { levelFromXp } from "../../src/services/gamificationService.js";

describe("levelFromXp", () => {
  it("starts at level 1 with 0 XP", () => {
    expect(levelFromXp(0)).toEqual({ level: 1, intoLevel: 0, needed: 100 });
  });

  it("advances to level 2 at 100 XP (100 * 1^1.5)", () => {
    expect(levelFromXp(99).level).toBe(1);
    expect(levelFromXp(100).level).toBe(2);
  });

  it("requires progressively more XP per level", () => {
    // level 2 → 3 costs round(100 * 2^1.5) = 283
    expect(levelFromXp(100 + 282).level).toBe(2);
    expect(levelFromXp(100 + 283).level).toBe(3);
  });

  it("reports progress within the current level", () => {
    const state = levelFromXp(150);
    expect(state.level).toBe(2);
    expect(state.intoLevel).toBe(50);
    expect(state.needed).toBe(283);
  });

  it("is monotonic — more XP never lowers the level", () => {
    let last = 1;
    for (let xp = 0; xp <= 10_000; xp += 137) {
      const { level } = levelFromXp(xp);
      expect(level).toBeGreaterThanOrEqual(last);
      last = level;
    }
  });
});
