import { describe, expect, it } from "vitest";
import { achievementRarity, type AchievementRarity } from "./achievementRarity";
import { ACHIEVEMENT_KEYS, type AchievementKey } from "../../../shared/achievementKeys";

// Pins the tier table of issue #124. Rarity is a pure function of the
// achievement key — no randomness, nothing stored, no server involvement
// (ADR-5: the gamification payload is untouched by this feature).
//
// REVIEWED is the tier *judgement* — the part a human signed off on, which no
// list can derive. The KEY SET it must cover is not hand-copied: it comes from
// shared/achievementKeys.ts, the same list the server's ACHIEVEMENTS
// definitions are typed against (a definition with an unlisted key fails the
// server typecheck). So adding an achievement server-side forces a key into the
// shared list, and "covers exactly the shipped achievement key set" below then
// fails until someone makes a deliberate tier call here.
//
// The importable list is why this works: a client unit test cannot import
// gamificationService (it pulls in db.js and better-sqlite3), which is what
// made an earlier hand-copied version of this list unable to notice an
// eleventh achievement. Same shape as shared/drawableVectors.ts (ADR-2).
const REVIEWED: Record<AchievementKey, AchievementRarity> = {
  first_draw: "common",
  first_completion: "common",
  streak_7: "rare",
  level_5: "rare",
  early_bird: "rare",
  monster_slayer: "rare",
  level_10: "epic",
  leverage_master: "epic",
  first_goal: "epic",
  streak_30: "legendary",
  deck_clearer: "legendary",
};

describe("achievementRarity", () => {
  // The drift guard: an achievement added server-side lands in the shared key
  // list, and this fails until it is given a tier above.
  it("covers exactly the shipped achievement key set — no untiered achievement", () => {
    expect(Object.keys(REVIEWED).sort()).toEqual([...ACHIEVEMENT_KEYS].sort());
  });

  it("maps every shipped achievement key to its reviewed tier", () => {
    for (const key of ACHIEVEMENT_KEYS) {
      expect(achievementRarity(key), key).toBe(REVIEWED[key]);
    }
  });

  it("keeps the reviewed distribution: 2 common / 4 rare / 3 epic / 2 legendary", () => {
    const counts = ACHIEVEMENT_KEYS.reduce<Record<string, number>>((acc, key) => {
      const tier = achievementRarity(key);
      acc[tier] = (acc[tier] ?? 0) + 1;
      return acc;
    }, {});
    expect(counts).toEqual({ common: 2, rare: 4, epic: 3, legendary: 2 });
  });

  it("reserves legendary for the two hardest unlocks", () => {
    // A 30-day unbroken streak and emptying the whole drawable deck — the only
    // two that cannot be reached by one action or one good week.
    expect(achievementRarity("streak_30")).toBe("legendary");
    expect(achievementRarity("deck_clearer")).toBe("legendary");
  });

  it("ranks the two level achievements apart — the grind is the difference", () => {
    expect(achievementRarity("level_5")).toBe("rare");
    expect(achievementRarity("level_10")).toBe("epic");
  });

  it("degrades an unknown key to common rather than throwing", () => {
    // The payload drives the grid: a future server-side achievement must
    // render as a plain card, never claim legendary shimmer, never blow up.
    expect(achievementRarity("not_a_real_achievement")).toBe("common");
    expect(achievementRarity("")).toBe("common");
  });

  it("is not fooled by prototype keys", () => {
    // Record<string, …> lookup would otherwise resolve Object.prototype members.
    expect(achievementRarity("toString")).toBe("common");
    expect(achievementRarity("constructor")).toBe("common");
  });
});
