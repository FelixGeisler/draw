import type { ActivityDay } from "../hooks/useActivity";
import { trophyRarity } from "./trophyRarity";

/**
 * The weekly run report (#233, ADR-65): a Monday-first local week folded from
 * the activity days the History calendar already fetches — pure aggregation,
 * no new API. Weeks are LOCAL calendar constructs (the #219 rules, the
 * History calendar's Monday-first convention); "this week" is the week
 * containing `today`, compared against the seven days before it.
 */
export interface WeekReport {
  /** Monday of the reported week, YYYY-MM-DD. */
  weekStart: string;
  completions: number;
  minutes: number;
  xp: number;
  /** Rarities minted this week (the #62 derivation over completed cards). */
  holos: number;
  silvers: number;
  /** The day with the most completions (ties: earliest), null when none. */
  bestDay: { date: string; completions: number } | null;
  /** This week minus last week. */
  deltaCompletions: number;
  deltaMinutes: number;
}

/** Monday of the week containing `day` — pure YYYY-MM-DD string math. */
export function weekStartOf(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  // getUTCDay: 0=Sun..6=Sat; Monday-first offset.
  const offset = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - offset);
  return d.toISOString().slice(0, 10);
}

function addDaysStr(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function fold(days: ActivityDay[]) {
  let completions = 0;
  let minutes = 0;
  let xp = 0;
  let holos = 0;
  let silvers = 0;
  let bestDay: { date: string; completions: number } | null = null;
  for (const day of days) {
    completions += day.totals.completed;
    minutes += day.totals.minutes;
    xp += day.totals.xp;
    for (const card of day.cards) {
      if (!card.completed) continue;
      const rarity = trophyRarity(card);
      if (rarity === "holo") holos++;
      if (rarity === "silver") silvers++;
    }
    if (day.totals.completed > 0 && day.totals.completed > (bestDay?.completions ?? 0)) {
      bestDay = { date: day.date, completions: day.totals.completed };
    }
  }
  return { completions, minutes, xp, holos, silvers, bestDay };
}

/**
 * Fold the report, or null when this week holds no activity at all — a recap
 * of nothing is noise, not encouragement.
 */
export function weeklyReport(days: ActivityDay[], today: string): WeekReport | null {
  const start = weekStartOf(today);
  const lastStart = addDaysStr(start, -7);
  const inWeek = (d: string, from: string) => d >= from && d < addDaysStr(from, 7);

  const thisWeek = fold(days.filter((d) => inWeek(d.date, start)));
  if (thisWeek.completions === 0 && thisWeek.minutes === 0) return null;
  const lastWeek = fold(days.filter((d) => inWeek(d.date, lastStart)));

  return {
    weekStart: start,
    ...thisWeek,
    deltaCompletions: thisWeek.completions - lastWeek.completions,
    deltaMinutes: thisWeek.minutes - lastWeek.minutes,
  };
}
