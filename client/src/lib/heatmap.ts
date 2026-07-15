// Contribution-style activity heatmap (#54): quantization and week-grid
// layout as pure functions, unit-tested without rendering. All date math is
// date-only arithmetic on YYYY-MM-DD strings via the UTC trick (no DST
// holes); the strings themselves are LOCAL calendar days straight from
// GET /api/activity (ADR-21) — this module never converts timezones.

/** Default range: the current week plus 25 before it — fits the Stats page. */
export const HEATMAP_WEEKS = 26;

/**
 * Quantization thresholds (tracked minutes, upper-exclusive). Fixed and
 * absolute, not data-relative: a 2-hour day earns the same shade no matter
 * what the surrounding weeks look like, so the heatmap reads as a consistency
 * record rather than a ranking against your own best week. Bucket meaning:
 * showed up (<15), a real dent (<45), a solid session (<120), a deep-work
 * day (120+). Level 0 is reserved for exactly zero.
 */
export const LEVEL_THRESHOLDS = [15, 45, 120] as const;

export type HeatLevel = 0 | 1 | 2 | 3 | 4;

/**
 * Tracked minutes → intensity level. Any activity at all — even a one-minute
 * dab — must be visually distinct from an empty day: showing up is the whole
 * anti-procrastination point (issue #54's metric decision).
 */
export function minutesLevel(minutes: number): HeatLevel {
  if (minutes <= 0) return 0;
  if (minutes < LEVEL_THRESHOLDS[0]) return 1;
  if (minutes < LEVEL_THRESHOLDS[1]) return 2;
  if (minutes < LEVEL_THRESHOLDS[2]) return 3;
  return 4;
}

/** Date-only arithmetic on YYYY-MM-DD strings (UTC trick avoids DST holes). */
export function addDays(dateStr: string, n: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * Monday-first row index (0 = Mon … 6 = Sun) — the same weekday order as the
 * TaskForm availability chips, so the app never shows two week conventions.
 */
export function mondayIndex(dateStr: string): number {
  return (new Date(`${dateStr}T00:00:00Z`).getUTCDay() + 6) % 7;
}

/** The Monday of the week containing dateStr. */
export function mondayOf(dateStr: string): string {
  return addDays(dateStr, -mondayIndex(dateStr));
}

/**
 * Inclusive [from, to] spanning `weeks` calendar weeks where the LAST week is
 * the (possibly partial) week containing `today`. `from` is always a Monday;
 * `to` is today itself, so the final column stops at the current day instead
 * of promising a future.
 */
export function heatmapRange(today: string, weeks = HEATMAP_WEEKS): { from: string; to: string } {
  return { from: addDays(mondayOf(today), -7 * (weeks - 1)), to: today };
}

/**
 * Grid layout: one column per calendar week (Monday-first), each column
 * exactly 7 entries — a date within [from, to] or null for the days the range
 * doesn't cover (leading nulls when `from` isn't a Monday, trailing nulls
 * after `to` in the current week). Null cells keep the weekday rows aligned.
 */
export function heatmapWeeks(from: string, to: string): (string | null)[][] {
  if (from > to) return [];
  const weeks: (string | null)[][] = [];
  for (let monday = mondayOf(from); monday <= to; monday = addDays(monday, 7)) {
    const week: (string | null)[] = [];
    for (let i = 0; i < 7; i++) {
      const day = addDays(monday, i);
      week.push(day >= from && day <= to ? day : null);
    }
    weeks.push(week);
  }
  return weeks;
}

/**
 * Month labels above the grid, as YYYY-MM keys (the component localizes).
 * A column is labelled when its week starts in a different month than the
 * previous column's. Month-change labels are always ≥ 4 columns apart, but a
 * range that starts mid-month can put the first month change right next to
 * column 0 — so column 0 gets its own month's label only when the next label
 * is at least 3 columns away (a "Jan 2026" label spans ~3 of the ~17px
 * columns; anything closer collides).
 */
export function monthLabels(weeks: (string | null)[][]): (string | null)[] {
  const monthOf = (week: (string | null)[]): string | null => {
    const first = week.find((d) => d !== null);
    return first ? first.slice(0, 7) : null;
  };
  const labels = weeks.map((week, i) => {
    if (i === 0) return null; // decided after the pass — see collision rule
    const cur = monthOf(week);
    const prev = monthOf(weeks[i - 1]);
    return cur !== null && prev !== null && cur !== prev ? cur : null;
  });
  if (weeks.length > 0 && labels.slice(1, 3).every((l) => l == null)) {
    labels[0] = monthOf(weeks[0]);
  }
  return labels;
}
