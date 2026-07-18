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
 *   - `server/test/unit/achievement-keys.test.ts` pins that every key here has
 *     exactly one definition (and no definition is missing);
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

/** Every achievement key the server can ship, in `ACHIEVEMENTS` display order. */
export const ACHIEVEMENT_KEYS = [
  "first_draw",
  "first_completion",
  "streak_7",
  "streak_30",
  "monster_slayer",
  "leverage_master",
  "deck_clearer",
  "level_5",
  "level_10",
  "early_bird",
  "first_goal",
] as const;

export type AchievementKey = (typeof ACHIEVEMENT_KEYS)[number];
