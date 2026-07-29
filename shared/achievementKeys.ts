/**
 * The canonical achievement key list (issue #124).
 *
 * Achievements are defined server-side (`ACHIEVEMENTS` + `checkAchievements` in
 * gamificationService) but *rendered* client-side with a collectible rarity tier
 * (`client/src/lib/achievementRarity.ts`). That is two lists in two workspaces
 * that must agree — the same shape as the drawable predicate (ADR-2 mirrors),
 * so it gets the same treatment as `shared/drawableVectors.ts`: one list here,
 * imported by both sides, so they cannot drift silently.
 *
 * The client cannot import `gamificationService` directly — that pulls in
 * `db.js` and better-sqlite3 — hence this hop. Both sides take it type-only or
 * test-only, so nothing here reaches the browser bundle:
 *
 *   - server `gamificationService.ts` types `AchievementDef.key` as
 *     `AchievementKey`, so a definition whose key is not listed here fails the
 *     server typecheck;
 *   - `server/test/integration/gamification.test.ts` pins that the payload
 *     ships exactly this key set (and `achievement-customization.test.ts`
 *     pins the ORDER);
 *   - client `achievementRarity.ts` declares its tier table
 *     `satisfies Record<AchievementKey, AchievementRarity>`, so a key here
 *     without a tier fails the CLIENT typecheck;
 *   - `client/src/lib/achievementRarity.test.ts` iterates this list, so the
 *     same gap also fails the client unit suite.
 *
 * Net: adding a server-side achievement forces a key here, and a key here
 * forces a deliberate tier — a new achievement cannot silently ship as a plain
 * common card.
 *
 * Keys only, not the full definitions: titles and descriptions are server-owned
 * user-facing copy that reaches the client through the `/api/gamification`
 * payload (ADR-5). Only the *key set* is the shared contract.
 *
 * This file must stay dependency-free: it is imported across both workspaces
 * (NodeNext on the server, bundler resolution on the client).
 */

/**
 * Every achievement key the server can ship, in `ACHIEVEMENTS` display order.
 *
 * Since #156 most keys belong to a MULTI-LEVEL CHAIN (draws, completions,
 * streak, level, goals, tracked hours) — each level is its own key so it fits
 * the append-only `achievements` table and this shared-key machinery. A handful
 * stay one-offs (event unlocks with no meaningful running total). The tier per
 * key lives next door in `shared/achievementTiers.ts`, imported by BOTH the
 * server (claim-XP values) and the client (styling) — the same drift-guard.
 */
export const ACHIEVEMENT_KEYS = [
  // Draws chain — non-warmup deals only (ADR-30), counted from the draws log.
  "first_draw",
  "draw_10",
  "draw_100",
  "draw_1000",
  "draw_10000",
  // Completions chain — from the completions log; undo lowers progress.
  "first_completion",
  "complete_25",
  "complete_100",
  "complete_500",
  "complete_2500",
  // Streak chain — real completion days in one unbroken run (#58).
  "streak_7",
  "streak_30",
  "streak_100",
  // Level chain — derived from total XP (completions + claims).
  "level_5",
  "level_10",
  "level_25",
  "level_50",
  // Goals-achieved chain — state-derived from achieved goals.
  "first_goal",
  "goals_5",
  "goals_25",
  // Tracked-time chain — from closed time_entries.
  "hours_10",
  "hours_100",
  "hours_1000",
  // One-offs — event unlocks with no running total (progress is null).
  "monster_slayer",
  "deck_clearer",
  "early_bird",
] as const;

export type AchievementKey = (typeof ACHIEVEMENT_KEYS)[number];
