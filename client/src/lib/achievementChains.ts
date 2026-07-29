// Collapse an achievement payload into ONE evolving card per chain (issue #183,
// ADR-47). The Stats grid used to render every tier of a chain at once (five
// draw cards, five completion cards...); this groups a chain's tiers and picks
// the single CURRENT tier to show. Kept out of the component and pure so the
// selector is unit-testable without a DOM (the client suite has no renderer) --
// the same pattern as lib/achievementRarity and lib/achievementEdit.

import { chainForKey } from "../../../shared/achievementChains";
import type { AchievementCardData } from "../components/AchievementCard";

/** The display state of one tier in a chain, for the card's pip row (#222). */
export type TierState = "claimed" | "unlocked" | "locked";

/** One collapsed slot in the grid: the card to render plus whether the
 *  chain/one-off it stands for has been earned at all (for the heading count). */
export interface CollapsedAchievement {
  /** The tier to render -- the current tier of a chain, or a one-off unchanged. */
  card: AchievementCardData;
  /**
   * True once ANY tier of this entry has unlocked. Monotonic on purpose: it
   * never drops when a tier is claimed and the current card advances to a
   * still-locked higher tier, so claiming XP can only ever raise the heading
   * "collected" count, never lower it.
   */
  collected: boolean;
  /**
   * Per-tier states in ascending `order`, for the pip row on the collapsed
   * card (#222) -- the collapse hides a chain's depth, and before the pips
   * nothing on the card said "this is rung 2 of 5". Absent for one-offs:
   * a single-tier pip row would be noise pretending to be information.
   */
  tierStates?: TierState[];
}

/**
 * The current tier of a chain: the first tier (ascending `order`) still
 * UNCLAIMED, so a claim skips the just-claimed tier and the next one becomes
 * current. If every tier is claimed the chain is maxed -- show the LAST (highest)
 * tier as a claimed card rather than letting the chain vanish.
 *
 * `tiers` need not be pre-sorted; a defensive copy is sorted by `order`.
 */
export function selectCurrentTier(tiers: AchievementCardData[]): AchievementCardData {
  const sorted = [...tiers].sort(
    (a, b) => (chainForKey(a.key)?.order ?? 0) - (chainForKey(b.key)?.order ?? 0),
  );
  return sorted.find((t) => t.claimedAt == null) ?? sorted[sorted.length - 1];
}

/**
 * Group the achievements payload by chain and collapse each chain to its
 * current tier; one-offs (no chain entry) pass through unchanged, each its own
 * slot. Order is FIRST-APPEARANCE order of chains and one-offs in the payload,
 * so the grid keeps the server's display order (ADR-5).
 */
export function collapseAchievementChains(
  achievements: AchievementCardData[],
): CollapsedAchievement[] {
  const order: string[] = [];
  const groups = new Map<string, AchievementCardData[]>();

  for (const a of achievements) {
    const chain = chainForKey(a.key);
    // One-offs get a unique per-key group id -- the "oneoff:" prefix can never
    // collide with a chainId (a bare metric name), so each renders standalone.
    const id = chain ? chain.chainId : `oneoff:${a.key}`;
    let bucket = groups.get(id);
    if (!bucket) {
      bucket = [];
      groups.set(id, bucket);
      order.push(id);
    }
    bucket.push(a);
  }

  return order.map((id) => {
    const members = groups.get(id)!;
    if (chainForKey(members[0].key) == null) {
      // One-off: single member, passed through.
      return { card: members[0], collected: members[0].unlockedAt != null };
    }
    const sorted = [...members].sort(
      (a, b) => (chainForKey(a.key)?.order ?? 0) - (chainForKey(b.key)?.order ?? 0),
    );
    return {
      card: selectCurrentTier(members),
      collected: members.some((m) => m.unlockedAt != null),
      tierStates: sorted.map((m): TierState =>
        m.claimedAt != null ? "claimed" : m.unlockedAt != null ? "unlocked" : "locked",
      ),
    };
  });
}
