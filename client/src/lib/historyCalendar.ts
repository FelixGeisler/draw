import type { ActivityDay } from "../hooks/useActivity";
import { trophyRarity, type TrophyRarity } from "./trophyRarity";
import { addDays, asLocalDate } from "./localDay";

// Pure layout + derivation for the Stats page's History contribution calendar
// (#174) — the GitHub-heatmap successor to the house-of-cards skyline. Kept out
// of the component (the buildActivityDays pattern) so the week bucketing,
// intensity level and per-day rarity are unit-testable without a DOM or a
// clock; `today` is always injected. Days are LOCAL calendar days (ADR-21),
// weeks start on MONDAY to match the app's Monday-first axis ticks.

const EMPTY_TOTALS: ActivityDay["totals"] = { started: 0, completed: 0, minutes: 0, xp: 0 };

/** Weekday of a YYYY-MM-DD, Monday = 0 … Sunday = 6. */
export function weekdayIndex(dateStr: string): number {
  return (asLocalDate(dateStr).getDay() + 6) % 7;
}

/** The Monday on or before `dateStr`. */
export function mondayOf(dateStr: string): string {
  return addDays(dateStr, -weekdayIndex(dateStr));
}

/**
 * Activity intensity bucket 0–4 for a day's totals (the heatmap tile shade).
 * Blends tracked minutes with completion count so a low-minute but multi-
 * completion day still reads as busy, and a completion-only day (marked done
 * with no timer, so 0 tracked minutes) still lights up at the lowest active
 * level instead of reading as empty.
 */
export function activityLevel(totals: ActivityDay["totals"]): number {
  if (totals.started === 0) return 0;
  if (totals.minutes >= 90 || totals.completed >= 3) return 4;
  if (totals.minutes >= 45 || totals.completed >= 2) return 3;
  if (totals.minutes >= 15 || totals.completed >= 1) return 2;
  return 1;
}

const RARITY_RANK: Record<TrophyRarity, number> = { none: 0, silver: 1, holo: 2 };

/**
 * The best drawn-card rarity among a day's COMPLETED cards (#62) — the tile
 * wears the day's rarest completion (holo > silver > none) as a collectible
 * glint, mirroring the skyline's per-card sheen at day granularity.
 */
export function dayRarity(day: ActivityDay): TrophyRarity {
  let best: TrophyRarity = "none";
  for (const c of day.cards) {
    if (!c.completed) continue;
    const r = trophyRarity(c);
    if (RARITY_RANK[r] > RARITY_RANK[best]) best = r;
  }
  return best;
}

export interface CalCell {
  /** null for a padding slot: a future day past `to` in the final week column. */
  date: string | null;
  level: number;
  rarity: TrophyRarity;
  isToday: boolean;
  /** The activity day (present for every in-range date; null only for padding). */
  day: ActivityDay | null;
}

export interface CalColumn {
  /** The Monday that starts this week column. */
  weekStart: string;
  /** Short month label when this column opens a new month, else null. */
  monthLabel: string | null;
  /** Exactly 7 cells, Monday … Sunday. */
  cells: CalCell[];
}

export interface CalSummary {
  activeDays: number;
  completed: number;
  minutes: number;
  xp: number;
}

export interface Calendar {
  columns: CalColumn[];
  summary: CalSummary;
}

/** Short month tag; January carries the year so a multi-year scroll stays oriented. */
function monthLabel(dateStr: string): string {
  const d = asLocalDate(dateStr);
  return d.toLocaleDateString(
    [],
    d.getMonth() === 0 ? { month: "short", year: "2-digit" } : { month: "short" },
  );
}

/**
 * Lay `days` out as Monday-first week COLUMNS. `from`/`to` are the inclusive
 * local-date window (from is expected Monday-aligned by the caller, but the
 * build re-anchors defensively); every date in [from, to] is expected present
 * in `days` (the server returns a dense range). Days past `to` in the final
 * column become inert padding so every column has 7 rows. Pure — no DOM, no
 * clock; `today` is injected for the isToday flag.
 */
export function buildCalendar(
  days: ActivityDay[],
  from: string,
  to: string,
  today: string,
): Calendar {
  const byDate = new Map(days.map((d) => [d.date, d]));
  const firstMonday = mondayOf(from);
  const lastMonday = mondayOf(to);
  const columns: CalColumn[] = [];
  const summary: CalSummary = { activeDays: 0, completed: 0, minutes: 0, xp: 0 };
  let prevMonth = "";

  for (let col = firstMonday; col <= lastMonday; col = addDays(col, 7)) {
    const cells: CalCell[] = [];
    for (let row = 0; row < 7; row++) {
      const date = addDays(col, row);
      if (date < from || date > to) {
        cells.push({ date: null, level: 0, rarity: "none", isToday: false, day: null });
        continue;
      }
      const day = byDate.get(date) ?? null;
      const totals = day?.totals ?? EMPTY_TOTALS;
      if (totals.started > 0) {
        summary.activeDays++;
        summary.completed += totals.completed;
        summary.minutes += totals.minutes;
        summary.xp += totals.xp;
      }
      cells.push({
        date,
        level: activityLevel(totals),
        rarity: day ? dayRarity(day) : "none",
        isToday: date === today,
        day,
      });
    }
    // Label a column when its month differs from the previous labelled one,
    // keyed off its first in-range day (the Monday, save the clamped first week).
    const anchor = cells.find((c) => c.date)?.date ?? col;
    const m = monthLabel(anchor);
    columns.push({ weekStart: col, monthLabel: m === prevMonth ? null : m, cells });
    prevMonth = m;
  }

  return { columns, summary };
}
