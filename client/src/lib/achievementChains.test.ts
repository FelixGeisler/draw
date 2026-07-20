import { describe, expect, it } from "vitest";
import { collapseAchievementChains, selectCurrentTier } from "./achievementChains";
import type { AchievementCardData } from "../components/AchievementCard";
import { ACHIEVEMENT_CHAINS } from "../../../shared/achievementChains";
import { ACHIEVEMENT_KEYS } from "../../../shared/achievementKeys";

// The current-tier selector + chain collapse of issue #183 (ADR-48). Pure over
// the /api/gamification payload shape, so it is exercised here with no renderer
// (the client suite has no DOM) -- the lib/achievementRarity precedent.

/** A minimal card in a given unlock/claim state; text fields are placeholders. */
function card(
  key: string,
  state: { unlocked?: boolean; claimed?: boolean; hidden?: boolean } = {},
): AchievementCardData {
  return {
    key,
    title: key,
    emoji: "*",
    description: key,
    hidden: state.hidden ?? false,
    customized: false,
    unlockedAt: state.unlocked || state.claimed ? "2026-01-01T00:00:00.000Z" : null,
    claimedAt: state.claimed ? "2026-01-02T00:00:00.000Z" : null,
    claimXp: state.claimed ? 25 : null,
    progress: null,
  };
}

// The draws chain, ascending: first_draw -> draw_10 -> ... -> draw_10000.
const DRAWS = ["first_draw", "draw_10", "draw_100", "draw_1000", "draw_10000"];

describe("selectCurrentTier", () => {
  it("picks the first UNCLAIMED tier (lowest order) -- a wholly unearned chain shows level 1", () => {
    const tiers = DRAWS.map((k) => card(k));
    expect(selectCurrentTier(tiers).key).toBe("first_draw");
  });

  it("advances past claimed tiers to the next unclaimed one", () => {
    const tiers = [
      card("first_draw", { claimed: true }),
      card("draw_10", { unlocked: true }), // unlocked, not yet claimed -> current
      card("draw_100"),
    ];
    expect(selectCurrentTier(tiers).key).toBe("draw_10");
  });

  it("falls back to the LAST (maxed) tier when every tier is claimed", () => {
    const tiers = DRAWS.map((k) => card(k, { claimed: true }));
    expect(selectCurrentTier(tiers).key).toBe("draw_10000");
  });

  it("does not depend on input order -- it sorts by chain order", () => {
    const shuffled = [card("draw_1000"), card("first_draw"), card("draw_100"), card("draw_10")];
    // first_draw is still the lowest-order unclaimed tier.
    expect(selectCurrentTier(shuffled).key).toBe("first_draw");
  });
});

describe("collapseAchievementChains", () => {
  it("renders exactly one card per chain -- the current tier", () => {
    const collapsed = collapseAchievementChains(DRAWS.map((k) => card(k)));
    expect(collapsed).toHaveLength(1);
    expect(collapsed[0].card.key).toBe("first_draw");
  });

  it("passes one-offs through unchanged, each its own slot", () => {
    const oneoffs = [
      card("monster_slayer", { unlocked: true }),
      card("early_bird"),
    ];
    const collapsed = collapseAchievementChains(oneoffs);
    expect(collapsed.map((c) => c.card.key)).toEqual(["monster_slayer", "early_bird"]);
    expect(collapsed.map((c) => c.collected)).toEqual([true, false]);
  });

  it("preserves first-appearance order of chains and one-offs", () => {
    const payload = [
      card("first_draw"), // draws chain
      card("draw_10"),
      card("early_bird", { unlocked: true }), // one-off
      card("first_completion"), // completions chain
      card("complete_25"),
    ];
    const collapsed = collapseAchievementChains(payload);
    expect(collapsed.map((c) => c.card.key)).toEqual([
      "first_draw",
      "early_bird",
      "first_completion",
    ]);
  });

  it("marks a chain collected once ANY tier has unlocked, even mid-advance", () => {
    // tier 1 claimed, current tier (draw_10) still locked -> collected stays true.
    const payload = [
      card("first_draw", { claimed: true }),
      card("draw_10"),
      card("draw_100"),
    ];
    const [entry] = collapseAchievementChains(payload);
    expect(entry.card.key).toBe("draw_10");
    expect(entry.card.unlockedAt).toBeNull(); // the shown card is face-down...
    expect(entry.collected).toBe(true); // ...yet the chain counts as collected
  });

  it("leaves a wholly-unearned chain uncollected, showing level 1 face-down", () => {
    const [entry] = collapseAchievementChains(DRAWS.map((k) => card(k)));
    expect(entry.card.key).toBe("first_draw");
    expect(entry.collected).toBe(false);
  });

  it("shows the maxed tier as collected once the whole chain is claimed", () => {
    const [entry] = collapseAchievementChains(DRAWS.map((k) => card(k, { claimed: true })));
    expect(entry.card.key).toBe("draw_10000");
    expect(entry.collected).toBe(true);
  });

  it("collapses hidden by the CURRENT tier's own hidden flag", () => {
    // The visible current tier carries the hidden flag the grid partitions on.
    const payload = [
      card("first_draw", { claimed: true }),
      card("draw_10", { hidden: true }),
    ];
    const [entry] = collapseAchievementChains(payload);
    expect(entry.card.key).toBe("draw_10");
    expect(entry.card.hidden).toBe(true);
  });
});

describe("chain map coverage", () => {
  // The one-offs the issue names: keys with no chain entry render standalone.
  it("leaves exactly the four one-offs un-chained", () => {
    const oneoffs = ACHIEVEMENT_KEYS.filter((k) => !(k in ACHIEVEMENT_CHAINS));
    expect([...oneoffs].sort()).toEqual(
      ["deck_clearer", "early_bird", "leverage_master", "monster_slayer"].sort(),
    );
  });

  it("only maps real achievement keys", () => {
    const keys = new Set<string>(ACHIEVEMENT_KEYS);
    for (const k of Object.keys(ACHIEVEMENT_CHAINS)) expect(keys.has(k), k).toBe(true);
  });
});
