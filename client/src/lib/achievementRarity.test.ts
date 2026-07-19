import { describe, expect, it } from "vitest";
import { achievementRarity, type AchievementRarity } from "./achievementRarity";
import { ACHIEVEMENT_KEYS, type AchievementKey } from "../../../shared/achievementKeys";

// Pins the 5-tier ladder of issue #156. Rarity is a pure function of the
// achievement key — no randomness, nothing client-stored — but since #156 the
// SERVER reads the same shared table to scale claim XP, so this is now a
// cross-workspace contract, not a presentation detail.
//
// REVIEWED is the tier *judgement* — the part a human signed off on, which no
// list can derive. The KEY SET it must cover is not hand-copied: it comes from
// shared/achievementKeys.ts, the same list the server's ACHIEVEMENTS
// definitions are typed against. So adding an achievement server-side forces a
// key into the shared list, and "covers exactly the shipped achievement key
// set" below then fails until someone makes a deliberate tier call in
// shared/achievementTiers.ts (which this mirrors).
const REVIEWED: Record<AchievementKey, AchievementRarity> = {
  // Draws chain
  first_draw: "common",
  draw_10: "rare",
  draw_100: "super-rare",
  draw_1000: "ultra-rare",
  draw_10000: "secret-rare",
  // Completions chain
  first_completion: "common",
  complete_25: "rare",
  complete_100: "super-rare",
  complete_500: "ultra-rare",
  complete_2500: "secret-rare",
  // Streak chain
  streak_7: "rare",
  streak_30: "ultra-rare",
  streak_100: "secret-rare",
  // Level chain
  level_5: "rare",
  level_10: "super-rare",
  level_25: "ultra-rare",
  level_50: "secret-rare",
  // Goals chain
  first_goal: "super-rare",
  goals_5: "ultra-rare",
  goals_25: "secret-rare",
  // Hours chain
  hours_10: "rare",
  hours_100: "super-rare",
  hours_1000: "ultra-rare",
  // One-offs
  monster_slayer: "rare",
  leverage_master: "super-rare",
  deck_clearer: "ultra-rare",
  early_bird: "rare",
};

describe("achievementRarity", () => {
  // The drift guard: an achievement added server-side lands in the shared key
  // list, and this fails until it is given a tier above (and in the shared
  // table this mirrors).
  it("covers exactly the shipped achievement key set — no untiered achievement", () => {
    expect(Object.keys(REVIEWED).sort()).toEqual([...ACHIEVEMENT_KEYS].sort());
  });

  it("maps every shipped achievement key to its reviewed tier", () => {
    for (const key of ACHIEVEMENT_KEYS) {
      expect(achievementRarity(key), key).toBe(REVIEWED[key]);
    }
  });

  it("keeps the reviewed distribution across the 5-tier ladder", () => {
    const counts = ACHIEVEMENT_KEYS.reduce<Record<string, number>>((acc, key) => {
      const tier = achievementRarity(key);
      acc[tier] = (acc[tier] ?? 0) + 1;
      return acc;
    }, {});
    expect(counts).toEqual({
      common: 2,
      rare: 7,
      "super-rare": 6,
      "ultra-rare": 7,
      "secret-rare": 5,
    });
  });

  it("reserves secret-rare for the extreme chain ends", () => {
    // The five deepest grinds: 10k draws, 2.5k completions, a 100-day streak,
    // level 50, and 25 goals — nothing reachable by one act or one good week.
    expect(achievementRarity("draw_10000")).toBe("secret-rare");
    expect(achievementRarity("complete_2500")).toBe("secret-rare");
    expect(achievementRarity("streak_100")).toBe("secret-rare");
    expect(achievementRarity("level_50")).toBe("secret-rare");
    expect(achievementRarity("goals_25")).toBe("secret-rare");
  });

  it("migrated the old top tiers: epic → super-rare, legendary → ultra-rare", () => {
    // level_10 was epic, streak_30 was legendary — the ladder shifted, the
    // relative ranking held.
    expect(achievementRarity("level_10")).toBe("super-rare");
    expect(achievementRarity("streak_30")).toBe("ultra-rare");
  });

  it("ranks the level chain by grind: 5 < 10 < 25 < 50", () => {
    expect(achievementRarity("level_5")).toBe("rare");
    expect(achievementRarity("level_10")).toBe("super-rare");
    expect(achievementRarity("level_25")).toBe("ultra-rare");
    expect(achievementRarity("level_50")).toBe("secret-rare");
  });

  it("degrades an unknown key to common rather than throwing", () => {
    // The payload drives the grid: a future server-side achievement must
    // render as a plain card, never claim secret-rare shimmer, never blow up.
    expect(achievementRarity("not_a_real_achievement")).toBe("common");
    expect(achievementRarity("")).toBe("common");
  });

  it("is not fooled by prototype keys", () => {
    // Object.hasOwn in the shared lookup keeps Object.prototype members out.
    expect(achievementRarity("toString")).toBe("common");
    expect(achievementRarity("constructor")).toBe("common");
  });
});
