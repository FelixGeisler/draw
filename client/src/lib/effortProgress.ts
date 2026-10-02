/**
 * Neutral completed-effort progress for goals with estimated leaves (#372).
 * Both inputs are already derived by the goals API. The client only clamps a
 * potentially skewed remaining value and presents completed minutes; nothing
 * is stored and the feasibility classifier remains independent.
 */
export interface EffortProgressState {
  total: number;
  remaining: number;
  completed: number;
  /** completed / total, clamped to [0, 1]. */
  pct: number;
}

export function effortProgress(goal: {
  remainingOpenEffortMinutes: number | null;
  totalEffortMinutes: number | null;
}): EffortProgressState | null {
  const total = goal.totalEffortMinutes ?? 0;
  // Without estimated leaves, the existing count-based progress remains the
  // fallback. A non-positive total cannot form a meaningful minute range.
  if (total <= 0) return null;

  const remaining = Math.max(0, Math.min(goal.remainingOpenEffortMinutes ?? 0, total));
  const completed = total - remaining;
  return {
    total,
    remaining,
    completed,
    pct: completed / total,
  };
}
