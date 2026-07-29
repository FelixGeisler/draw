/**
 * Deterministic even-split pre-fill for the split-in-place editor (#108).
 * Mirrors `evenSplit`/`splitPlan` in server/src/services/aiPostprocess.ts
 * (#28): ceil(minutes / maxEffort) near-equal whole-minute parts that
 * PRESERVE the total — splitting must never silently rewrite the estimate —
 * capped at MAX_SPLIT_PARTS like the generate-tasks pipeline. When the cap
 * wins, parts may still exceed maxEffort: accepted — a too-big part can be
 * split again (decomposition is unlimited by repetition, not by depth).
 */

export const MAX_SPLIT_PARTS = 10;

/** Split `total` minutes into `count` near-equal whole-minute parts that sum to `total`. */
export function evenSplit(total: number, count: number): number[] {
  const base = Math.floor(total / count);
  const remainder = total - base * count;
  return Array.from({ length: count }, (_, i) => (i < remainder ? base + 1 : base));
}

/**
 * `minParts` floors the part count (#209). A subtask at or under maxEffort
 * needs only one part by the size arithmetic, which would seed a lone row
 * titled "… (part 1/1)" — nonsense for an editor whose whole premise is
 * replacing one step with several. The split affordance is no longer scoped
 * to too-big rows, so the call site asks for 2. Defaults to 1, leaving the
 * server mirror (`splitPlan` in aiPostprocess.ts) exact for every other path.
 */
export function evenSplitPlan(
  title: string,
  minutes: number,
  maxEffort: number,
  minParts = 1,
): { title: string; effortMinutes: number }[] {
  const bySize = Math.ceil(minutes / maxEffort);
  const count = Math.min(Math.max(bySize, minParts), MAX_SPLIT_PARTS);
  return evenSplit(minutes, count).map((m, i) => ({
    title: `${title} (part ${i + 1}/${count})`,
    effortMinutes: m,
  }));
}
