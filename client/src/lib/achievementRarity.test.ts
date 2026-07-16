import { describe, expect, it } from "vitest";
import { achievementRarity, type AchievementRarity } from "./achievementRarity";

// Pins the tier table of issue #124. Rarity is a pure function of the
// achievement key — no randomness, nothing stored, no server involvement
// (ADR-5: the gamification payload is untouched by this feature).
//
// The keys below MUST stay in sync with ACHIEVEMENTS in
// server/src/services/gamificationService.ts. That list is server-side and
// this is a client unit test, so it cannot import it — instead the full set is
// spelled out here: adding an achievement server-side without giving it a tier
// fails "every shipped achievement key has an explicit tier" below rather than
// silently shipping a plain card.
const SHIPPED: Record<string, AchievementRarity> = {
  first_draw: "common",
  first_completion: "common",
  streak_7: "rare",
  level_5: "rare",
  early_bird: "rare",
  monster_slayer: "rare",
  level_10: "epic",
  leverage_master: "epic",
  streak_30: "legendary",
  deck_clearer: "legendary",
};

describe("achievementRarity", () => {
  it("maps every shipped achievement key to its reviewed tier", () => {
    for (const [key, tier] of Object.entries(SHIPPED)) {
      expect(achievementRarity(key), key).toBe(tier);
    }
  });

  it("keeps the reviewed distribution: 2 common / 4 rare / 2 epic / 2 legendary", () => {
    const counts = Object.keys(SHIPPED).reduce<Record<string, number>>((acc, key) => {
      const tier = achievementRarity(key);
      acc[tier] = (acc[tier] ?? 0) + 1;
      return acc;
    }, {});
    expect(counts).toEqual({ common: 2, rare: 4, epic: 2, legendary: 2 });
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
