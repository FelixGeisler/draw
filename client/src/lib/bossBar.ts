/** The feasibility chip's verdict states (lib/feasibility.ts), or null when
 *  the classifier had nothing honest to say. */
export type FeasibilityState = "done" | "unknown" | "on-track" | "tight" | "infeasible" | null;

/**
 * Boss battles (#229): a goal's remaining work rendered as an opponent's HP
 * bar. Pure derivation over two fields the goals payload already computes —
 * max HP is the effort of every non-archived leaf (open and done), current HP
 * is what still stands open. Completions "deal damage" by shrinking the
 * remaining sum; nothing is stored, nothing new is written (ADR-2).
 *
 * This deliberately renders WORK, never judgement: the bar is arithmetic
 * about minutes, not a grade of the user's choices (ADR-48). The enrage state
 * is the feasibility chip's own `infeasible` verdict wearing war paint — one
 * source of truth, two costumes.
 */
export interface BossBarState {
  maxHp: number;
  /** Minutes still standing. 0 = the boss is downed (all estimated leaves done). */
  hp: number;
  /** hp / maxHp, clamped to [0, 1]. */
  pct: number;
  /** Damage dealt so far, for the "312 dmg" caption. */
  damage: number;
  enraged: boolean;
}

export function bossBar(
  goal: { remainingOpenEffortMinutes: number | null; totalEffortMinutes: number | null },
  feasibility: FeasibilityState,
): BossBarState | null {
  const maxHp = goal.totalEffortMinutes ?? 0;
  // No estimated leaves — no HP to mean anything. The count-based progress
  // bar remains the fallback rendering for these goals.
  if (maxHp <= 0) return null;
  const hp = Math.max(0, Math.min(goal.remainingOpenEffortMinutes ?? 0, maxHp));
  return {
    maxHp,
    hp,
    pct: hp / maxHp,
    damage: maxHp - hp,
    enraged: feasibility === "infeasible",
  };
}
