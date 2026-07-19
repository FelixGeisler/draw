/**
 * Collectible rarity for achievement cards — a thin client lookup over the
 * SHARED tier table (issue #156). Rarity used to live only here; claim-for-XP
 * made it a contract the server also reads (it scales claim XP by tier), so the
 * source of truth moved to `shared/achievementTiers.ts`, imported by both
 * sides. This file stays as the client's named entry point (many components
 * import `achievementRarity`), but it no longer OWNS the table — it forwards to
 * the shared one, so the two can never drift.
 *
 * The 5-tier TCG ladder (common → secret-rare) replaced the old
 * common/rare/epic/legendary set: epic → super-rare, legendary → ultra-rare,
 * plus the new top tier secret-rare for the extreme chain ends. Difficulty is a
 * design judgement per key, pinned by achievementRarity.test.ts against the
 * shared table.
 */
import { tierForKey, type AchievementTier } from "../../../shared/achievementTiers";

/** The rarity ladder — an alias of the shared tier type so callers keep one
 *  name. Widening to the shared union is deliberate: the CSS classes, the
 *  sheen map and the screen-reader label all speak these five words. */
export type AchievementRarity = AchievementTier;

/**
 * Tier for an achievement key. Unknown key → "common": the payload drives the
 * grid, so a future server-side achievement renders as a plain card instead of
 * throwing or claiming secret-rare shimmer. The shared lookup guards against
 * prototype keys (`toString`) too.
 */
export function achievementRarity(key: string): AchievementRarity {
  return tierForKey(key);
}
