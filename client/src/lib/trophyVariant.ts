/**
 * Deterministic trophy design per achieved goal (#204). The Hall of Fame used
 * to hang the same gold cup for every goal; now six designs rotate, picked
 * from the goal's id — derived at render time, never stored, no API surface
 * (the ADR-2 / trophyRarity pattern). Same goal, same trophy, forever, on
 * every device.
 *
 * Plain `id % N` rather than a hash, and that is a feature: goal ids are
 * assigned sequentially, so goals achieved near each other in time land on
 * DIFFERENT designs — two identical trophies can only stand together once six
 * goals apart in creation order. A "better-mixed" hash would trade that
 * adjacent-variety guarantee for the appearance of randomness.
 *
 * The order below is load-bearing in one spot: "cup" first keeps the classic
 * cup in the rotation as the design the empty-state ghost already shows.
 * Reordering or inserting mid-list reshuffles every existing shelf — append
 * new designs at the END.
 */

export const TROPHY_VARIANTS = ["cup", "chalice", "star", "laurel", "obelisk", "shield"] as const;

export type TrophyVariant = (typeof TROPHY_VARIANTS)[number];

export function trophyVariant(goalId: number): TrophyVariant {
  // SQLite rowids start at 1, but a backup import or manual edit owes us
  // nothing — floor + abs make any integer-ish input land in range.
  const id = Math.abs(Math.floor(goalId));
  return TROPHY_VARIANTS[id % TROPHY_VARIANTS.length];
}
