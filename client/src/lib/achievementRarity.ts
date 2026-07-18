/**
 * Deterministic collectible rarity for achievement cards (issue #124), the
 * sibling of trophyRarity: a pure client-side lookup keyed by achievement key,
 * derived at render time. Nothing is stored, no API surface changes — the
 * server's ACHIEVEMENTS definitions, the `achievements` table and the
 * /api/gamification payload stay exactly as they are (ADR-5, append-only
 * gamification state). Rarity is presentation.
 *
 * The tiers rank the REAL unlock difficulty of the definitions in
 * gamificationService (`ACHIEVEMENTS` + `checkAchievements`), so the shimmer
 * on the Stats page means something:
 *
 *   common     a single action on day one
 *   rare       a run, a threshold, or one deliberate well-aimed completion
 *   epic       a long grind, or sustained behavior across a whole week
 *   legendary  a 30-day unbroken streak / emptying the whole drawable deck
 *
 * Kept as an explicit table rather than derived from the key (e.g. parsing
 * "streak_30"): difficulty is a design judgement per achievement, not a
 * function of its name — `level_5` and `level_10` differ by a grind, not by a
 * number. The distribution (2 common / 4 rare / 3 epic / 2 legendary) is pinned
 * in achievementRarity.test.ts.
 *
 * The table is keyed off shared/achievementKeys.ts, the same list the server's
 * ACHIEVEMENTS definitions are typed against — so adding a server-side
 * achievement without giving it a tier fails this typecheck (the `satisfies`
 * below is exhaustive over AchievementKey) and the unit suite, rather than
 * silently shipping a plain card. The import is type-only, so the shared list
 * never reaches the bundle: the payload still drives the grid at runtime.
 */
import type { AchievementKey } from "../../../shared/achievementKeys";

export type AchievementRarity = "legendary" | "epic" | "rare" | "common";

const RARITY = new Map<string, AchievementRarity>(Object.entries({
  first_draw: "common", // one click, on day one
  first_completion: "common", // the first task ever finished
  streak_7: "rare", // 7 real completion days in an unbroken run (#58)
  level_5: "rare", // steady early XP accumulation
  early_bird: "rare", // one 5★ task finished on/before its due date
  monster_slayer: "rare", // every subtask (≥2 done) of one big task
  level_10: "epic", // the long-haul XP grind
  leverage_master: "epic", // ≥60% of a week's tracked time on 4–5★ — sustained, not a single act
  first_goal: "epic", // a goal spans weeks of work — the grind tier, not a single act (#145)
  streak_30: "legendary", // 30 completed days in ONE unbroken streak
  deck_clearer: "legendary", // empty the whole drawable deck by completing it
  // Exhaustive over AchievementKey, not Record<string, …>: a key added to the
  // shared list without a tier here is a compile error, not a silent common.
} satisfies Record<AchievementKey, AchievementRarity>));

/**
 * Unknown key -> "common": the payload drives the grid, so a future
 * server-side achievement renders as a plain card instead of throwing or
 * disappearing. Degrading toward the quietest tier is deliberate — an
 * untiered achievement must never claim legendary shimmer.
 *
 * A Map, not a plain-object lookup: keys arrive from the API payload, and
 * `RARITY["toString"]` on an object literal would resolve Object.prototype's
 * member and hand back a function typed as a tier.
 */
export function achievementRarity(key: string): AchievementRarity {
  return RARITY.get(key) ?? "common";
}
