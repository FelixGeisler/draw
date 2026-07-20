/**
 * The 5-tier TCG rarity ladder for achievements (issue #156, ADR-42).
 *
 * Rarity used to be a pure CLIENT lookup (achievementRarity.ts). Claim-for-XP
 * makes it a shared contract: the SERVER scales claim XP by tier, and the
 * client styles by tier — two lists that must agree, so the tier per key lives
 * here, next to the shared key list, imported by both sides. The same
 * drift-guard as `shared/achievementKeys.ts`:
 *
 *   - server `gamificationService.ts` reads `claimXpForKey` at claim time, so
 *     the client is never the XP authority;
 *   - client `achievementRarity.ts` is a thin lookup over `ACHIEVEMENT_TIERS`;
 *   - `ACHIEVEMENT_TIERS satisfies Record<AchievementKey, AchievementTier>`, so
 *     a key added to the shared list without a tier fails BOTH typechecks;
 *   - `achievementRarity.test.ts` pins the resulting distribution.
 *
 * This file must stay dependency-free: it is imported across both workspaces
 * (NodeNext on the server, bundler resolution on the client). It takes only a
 * type-only import from the sibling key list, so nothing here reaches the
 * browser bundle beyond the constant table.
 */
import type { AchievementKey } from "./achievementKeys.js";

/**
 * The ladder, common → secret-rare. Existing tiers migrated at #156:
 * epic → super-rare, legendary → ultra-rare. secret-rare is reserved for the
 * extreme chain ends (10000 draws, 2500 completions, 100-day streak, level 50,
 * 25 goals) and gets the one deliberate new card treatment (dark/negative frame
 * + holo + distinct border) — the rest reuse the two shipped sheens
 * (holo/silver, the "glint, not casino" doctrine). trophyRarity (task trophies)
 * keeps its own separate 3-tier vocabulary — untouched.
 */
export type AchievementTier = "common" | "rare" | "super-rare" | "ultra-rare" | "secret-rare";

/**
 * XP paid when an unlocked achievement is CLAIMED, by tier (issue #156). The
 * server stamps `achievements.claim_xp` from this table at claim time; the
 * client shows the same prospective value from the same source, but the stored
 * amount is the server's word.
 */
export const TIER_CLAIM_XP: Record<AchievementTier, number> = {
  common: 25,
  rare: 50,
  "super-rare": 100,
  "ultra-rare": 250,
  "secret-rare": 500,
};

/**
 * The tier per achievement key. Difficulty is a design judgement per level, not
 * a function of the name — so it is spelled out, exhaustively over
 * `AchievementKey` (the `satisfies` makes an untiered key a compile error on
 * both sides rather than a silent common).
 */
export const ACHIEVEMENT_TIERS = {
  // Draws — a single deal, then the long grind to five figures.
  first_draw: "common",
  draw_10: "rare",
  draw_100: "super-rare",
  draw_1000: "ultra-rare",
  draw_10000: "secret-rare",
  // Completions — the same shape, from the first task to a lifetime of them.
  first_completion: "common",
  complete_25: "rare",
  complete_100: "super-rare",
  complete_500: "ultra-rare",
  complete_2500: "secret-rare",
  // Streak — a week, a month, a hundred completed days.
  streak_7: "rare",
  streak_30: "ultra-rare",
  streak_100: "secret-rare",
  // Level — steady XP, then a genuine long haul.
  level_5: "rare",
  level_10: "super-rare",
  level_25: "ultra-rare",
  level_50: "secret-rare",
  // Goals — each spans weeks of real work.
  first_goal: "super-rare",
  goals_5: "ultra-rare",
  goals_25: "secret-rare",
  // Tracked hours — ten, a hundred, a thousand.
  hours_10: "rare",
  hours_100: "super-rare",
  hours_1000: "ultra-rare",
  // One-offs — a single deliberate act.
  monster_slayer: "rare",
  deck_clearer: "ultra-rare",
  early_bird: "rare",
  // Exhaustive over AchievementKey, not Record<string, …>: a key added to the
  // shared list without a tier here is a compile error, not a silent common.
} satisfies Record<AchievementKey, AchievementTier>;

/**
 * Tier for a key. Unknown key → "common": the payload drives the grid, so a
 * future server-side achievement renders as a plain card instead of throwing —
 * degrading toward the quietest tier, never claiming secret-rare shimmer.
 * The key is looked up via `Object.hasOwn` so a payload key like "toString"
 * cannot resolve an `Object.prototype` member.
 */
export function tierForKey(key: string): AchievementTier {
  return Object.hasOwn(ACHIEVEMENT_TIERS, key)
    ? ACHIEVEMENT_TIERS[key as AchievementKey]
    : "common";
}

/** Claim XP for a key, via its tier. Unknown key → the common payout. */
export function claimXpForKey(key: string): number {
  return TIER_CLAIM_XP[tierForKey(key)];
}
