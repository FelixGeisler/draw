/**
 * Pure display helpers for goal resolution (#145), shared by the victory
 * overlay and the Hall of Fame shelf. resolvedAt may be NULL on goals
 * resolved before migration v12 — every caller renders nothing rather than
 * a guessed date, and targetDelta answers null for the same reason.
 */

/** "12 Jul 2026" — a resolution is a moment, but it reads as a day. */
export function formatResolvedDate(resolvedAt: string): string {
  // Fixed locale: this string is UI copy, not user data — en-GB gives the
  // compact day-first form everywhere (and keeps tests deterministic).
  return new Date(resolvedAt).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/**
 * Tracked time for the victory stats chip: hours once it stops reading as
 * minutes, one decimal while the number is small enough for it to matter.
 */
export function formatTrackedMinutes(minutes: number): string {
  if (minutes < 60) return `~${Math.round(minutes)} min`;
  const hours = minutes / 60;
  return `~${hours >= 10 ? Math.round(hours) : Math.round(hours * 10) / 10} h`;
}

/**
 * "3d before target" / "2d after target" / "on target day" — how the
 * resolution landed against the goal's target date, day-granular on the
 * local calendar (targetDate is a date-only string; resolvedAt is a UTC
 * instant, truncated to its local day like every day-level display).
 */
export function targetDelta(
  targetDate: string | null,
  resolvedAt: string | null,
): string | null {
  if (!targetDate || !resolvedAt) return null;
  const resolved = new Date(resolvedAt);
  const resolvedDay = new Date(resolved.getFullYear(), resolved.getMonth(), resolved.getDate());
  const target = new Date(`${targetDate}T00:00:00`);
  const days = Math.round((target.getTime() - resolvedDay.getTime()) / 86_400_000);
  if (days === 0) return "on target day";
  return days > 0 ? `${days}d before target` : `${-days}d after target`;
}
