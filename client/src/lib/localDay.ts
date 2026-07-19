// Shared LOCAL-calendar-day helpers (PR #72 review): every activity view —
// today the skyline (components/Skyline) and the streak flame — must agree
// about which local day an activity belongs to (ADR-21), so the day math
// and formatting live here once instead of as drifting copies. Days are
// YYYY-MM-DD strings; arithmetic uses the UTC trick (no DST holes) while
// parsing-for-display stays local.

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** Today as a LOCAL date string — activity days are local calendar days. */
export function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Date-only arithmetic on YYYY-MM-DD strings (UTC trick avoids DST holes). */
export function addDays(dateStr: string, n: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Whole days from `a` to `b` (positive when b is later). */
export function diffDays(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/** "2026-07-15" → local Date (date-only strings without Z parse as local). */
export function asLocalDate(dateStr: string): Date {
  return new Date(`${dateStr}T00:00:00`);
}

/**
 * Human-facing day label. Always includes the year: activity views are
 * permanent multi-year records, and without it a 2025 day and a 2026 day
 * read identically (PR #68 review).
 */
export function formatDay(dateStr: string): string {
  return asLocalDate(dateStr).toLocaleDateString([], {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}
