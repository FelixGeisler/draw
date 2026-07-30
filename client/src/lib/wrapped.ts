import type { ActivityDay } from "../hooks/useActivity";
import type { AchievementRarity } from "./achievementRarity";
import { trophyRarity } from "./trophyRarity";

/**
 * Draw Wrapped (#234): one calendar year folded client-side from payloads the
 * app already fetches — activity days, the gamification snapshot, and the
 * goals list. Pure date-string math over an injected "today" (#219 rules);
 * nothing is stored, nothing leaves the machine.
 */
export interface WrappedStats {
  year: number;
  cardsCompleted: number;
  /** Whole hours, floored — "127 hours" reads better than 7620 minutes. */
  hoursTracked: number;
  xpEarned: number;
  holos: number;
  /** Longest run of completion days, bridged like the live streak: frozen
   *  days and configured rest weekdays keep a run alive but never count. */
  deepestStreak: number;
  /** Rarest achievement unlocked this year (ties: latest), or null. */
  rarestAchievement: { title: string; emoji: string; rarity: AchievementRarity } | null;
  /** The achieved goal that took the most completed cards this year, or null. */
  biggestGoal: { title: string; doneCount: number } | null;
}

export interface WrappedInputs {
  year: number;
  /** Activity days covering the year (extra days outside it are ignored). */
  days: ActivityDay[];
  /** Full-history freeze-covered local days (gamification snapshot). */
  frozenDays: string[];
  /** Configured rest weekdays, 0=Sun..6=Sat (settings). Applied to the whole
   *  year as-is — config history isn't recorded, and pretending otherwise
   *  would be a second streak implementation. */
  restWeekdays: number[];
  achievements: { title: string; emoji: string; unlockedAt: string | null; rarity: AchievementRarity }[];
  goals: { title: string; status: string; resolvedAt: string | null; doneCount: number }[];
}

/** The shared 5-tier TCG ladder, weakest first (shared/achievementTiers). */
const RARITY_ORDER: AchievementRarity[] = ["common", "rare", "super-rare", "ultra-rare", "secret-rare"];

function weekdayOf(day: string): number {
  return new Date(`${day}T00:00:00Z`).getUTCDay();
}

function nextDay(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** Longest completion-day count in any bridged run inside the year. */
export function deepestStreak(
  completionDays: string[],
  frozenDays: string[],
  restWeekdays: number[],
): number {
  if (completionDays.length === 0) return 0;
  const completed = new Set(completionDays);
  const frozen = new Set(frozenDays);
  const rest = new Set(restWeekdays);
  const sorted = [...completed].sort();
  let best = 1;
  let run = 1;
  for (let i = 1; i < sorted.length; i++) {
    // Walk the gap: every day between two completions must be bridgeable.
    let d = nextDay(sorted[i - 1]);
    let bridged = true;
    while (d < sorted[i]) {
      if (!frozen.has(d) && !rest.has(weekdayOf(d))) {
        bridged = false;
        break;
      }
      d = nextDay(d);
    }
    run = bridged ? run + 1 : 1;
    if (run > best) best = run;
  }
  return best;
}

export function wrappedStats(inputs: WrappedInputs): WrappedStats | null {
  const { year } = inputs;
  const inYear = (d: string | null): d is string => d != null && d.startsWith(`${year}-`);
  const days = inputs.days.filter((d) => inYear(d.date));

  let cardsCompleted = 0;
  let minutes = 0;
  let xpEarned = 0;
  let holos = 0;
  for (const day of days) {
    cardsCompleted += day.totals.completed;
    minutes += day.totals.minutes;
    xpEarned += day.totals.xp;
    for (const card of day.cards) {
      if (card.completed && trophyRarity(card) === "holo") holos++;
    }
  }
  if (cardsCompleted === 0 && minutes === 0) return null;

  const unlocked = inputs.achievements.filter((a) => inYear(a.unlockedAt));
  unlocked.sort(
    (a, b) =>
      RARITY_ORDER.indexOf(b.rarity) - RARITY_ORDER.indexOf(a.rarity) ||
      (b.unlockedAt as string).localeCompare(a.unlockedAt as string),
  );
  const rarest = unlocked[0] ?? null;

  const felled = inputs.goals
    .filter((g) => g.status === "achieved" && inYear(g.resolvedAt))
    .sort((a, b) => b.doneCount - a.doneCount);

  return {
    year,
    cardsCompleted,
    hoursTracked: Math.floor(minutes / 60),
    xpEarned,
    holos,
    deepestStreak: deepestStreak(
      days.filter((d) => d.totals.completed > 0).map((d) => d.date),
      inputs.frozenDays,
      inputs.restWeekdays,
    ),
    rarestAchievement: rarest
      ? { title: rarest.title, emoji: rarest.emoji, rarity: rarest.rarity }
      : null,
    biggestGoal: felled[0] ? { title: felled[0].title, doneCount: felled[0].doneCount } : null,
  };
}
