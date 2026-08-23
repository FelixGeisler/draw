import { describe, expect, it } from "vitest";
import {
  TIER_CLAIM_GOLD,
  claimGoldForKey,
  type AchievementTier,
} from "../../../shared/achievementTiers.js";

describe("achievement claim Gold", () => {
  it("pins all five approved tier payouts in the shared typed map", () => {
    expect(TIER_CLAIM_GOLD satisfies Record<AchievementTier, number>).toEqual({
      common: 5,
      rare: 10,
      "super-rare": 25,
      "ultra-rare": 50,
      "secret-rare": 100,
    });
  });

  it("looks up representative keys through their shared tier, not claim XP", () => {
    expect([
      claimGoldForKey("first_draw"),
      claimGoldForKey("draw_10"),
      claimGoldForKey("first_goal"),
      claimGoldForKey("draw_1000"),
      claimGoldForKey("draw_10000"),
    ]).toEqual([5, 10, 25, 50, 100]);
  });
});
