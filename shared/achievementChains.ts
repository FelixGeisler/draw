/**
 * The client-side chain map for achievements (issue #183).
 *
 * Most achievement keys belong to a MULTI-LEVEL CHAIN (#156): each level is its
 * own key sharing one running metric (draws, completions, streak, level, goals,
 * tracked hours). The server owns the chain in `CHAIN_SPECS`
 * (`gamificationService.ts`) — `{ metric, target }` per level — but that module
 * pulls in `db.js`/better-sqlite3, so the client cannot import it. This file is
 * the same dependency-free hop as `shared/achievementKeys.ts` /
 * `shared/achievementTiers.ts`: one map here, imported by the client to COLLAPSE
 * a chain's tiers into a single evolving current-tier card (ADR-47), and pinned
 * against `CHAIN_SPECS` by a server drift-guard so the two cannot disagree.
 *
 * The mapping is a pure PROJECTION of `CHAIN_SPECS`:
 *   - `chainId` = the shared `metric` (every level of a chain shares it);
 *   - `order`   = the shared `target` (targets ascend within a chain, so sorting
 *                 by `order` gives the tier progression).
 * `server/test/unit/achievement-chains-map.test.ts` asserts this file equals the
 * projection of `CHAIN_SPECS` exactly — add a chain level server-side and the
 * guard fails until it is mirrored here.
 *
 * Keys with no entry here are the one-offs (monster_slayer, leverage_master,
 * deck_clearer, early_bird) — event unlocks with no running total, which render
 * standalone. `client/src/lib/achievementChains.test.ts` pins that the
 * un-chained keys are exactly those four.
 *
 * This file must stay dependency-free: it is imported across both workspaces
 * (NodeNext on the server, bundler resolution on the client). It takes only a
 * type-only import from the sibling key list, so nothing here reaches the
 * browser bundle beyond the constant table.
 */
import type { AchievementKey } from "./achievementKeys.js";

/** A chained key's position: which chain it belongs to and its rung on it. */
export interface ChainPosition {
  /** The shared running metric — every level of one chain carries the same id. */
  chainId: string;
  /** The level's threshold; ascending `order` is ascending tier within a chain. */
  order: number;
}

/**
 * Every CHAINED achievement key → its `{ chainId, order }`. The projection of
 * the server's `CHAIN_SPECS`: `chainId` = `metric`, `order` = `target`. Typed
 * `satisfies Partial<Record<AchievementKey, …>>` so a key here that is not a
 * real achievement key fails the typecheck on both sides; the one-offs are
 * deliberately absent.
 */
export const ACHIEVEMENT_CHAINS = {
  // Draws chain.
  first_draw: { chainId: "draws", order: 1 },
  draw_10: { chainId: "draws", order: 10 },
  draw_100: { chainId: "draws", order: 100 },
  draw_1000: { chainId: "draws", order: 1000 },
  draw_10000: { chainId: "draws", order: 10000 },
  // Completions chain.
  first_completion: { chainId: "completions", order: 1 },
  complete_25: { chainId: "completions", order: 25 },
  complete_100: { chainId: "completions", order: 100 },
  complete_500: { chainId: "completions", order: 500 },
  complete_2500: { chainId: "completions", order: 2500 },
  // Streak chain.
  streak_7: { chainId: "streak", order: 7 },
  streak_30: { chainId: "streak", order: 30 },
  streak_100: { chainId: "streak", order: 100 },
  // Level chain.
  level_5: { chainId: "level", order: 5 },
  level_10: { chainId: "level", order: 10 },
  level_25: { chainId: "level", order: 25 },
  level_50: { chainId: "level", order: 50 },
  // Goals-achieved chain.
  first_goal: { chainId: "goals", order: 1 },
  goals_5: { chainId: "goals", order: 5 },
  goals_25: { chainId: "goals", order: 25 },
  // Tracked-time chain.
  hours_10: { chainId: "hours", order: 10 },
  hours_100: { chainId: "hours", order: 100 },
  hours_1000: { chainId: "hours", order: 1000 },
} satisfies Partial<Record<AchievementKey, ChainPosition>>;

/**
 * The chain position for a key, or null for a one-off / unknown key. Looked up
 * via `Object.hasOwn` so a payload key like "toString" cannot resolve an
 * `Object.prototype` member (the `tierForKey` precedent).
 */
export function chainForKey(key: string): ChainPosition | null {
  return Object.hasOwn(ACHIEVEMENT_CHAINS, key)
    ? ACHIEVEMENT_CHAINS[key as keyof typeof ACHIEVEMENT_CHAINS]
    : null;
}
