import { db, getSetting, getSettingString } from "../db.js";
import { ACHIEVEMENT_KEYS, type AchievementKey } from "../../../shared/achievementKeys.js";
import { claimXpForKey } from "../../../shared/achievementTiers.js";
import { clearCurrentDraw, getLastWarmupDeal, getWarmupMarker } from "./drawService.js";
import { localDate } from "./localDay.js";
import {
  computeStreak,
  FREEZE_BANK_CAP,
  shouldEarnFreeze,
  type StreakState,
} from "./streak.js";

// Public setting (routes/settings.ts allowlist): JSON array of rest weekdays
// in JS getDay convention (0=Sun..6=Sat), same as tasks.window_days. Absent
// or empty = pre-#58 behavior (every day required).
export const REST_WEEKDAYS_SETTING = "streak_rest_weekdays";

export interface TaskRow {
  id: number;
  title: string;
  impact: number;
  effort_minutes: number | null;
  recur_every_days: number | null;
  status: string;
  due_date: string | null;
  last_drawn_at: string | null;
}

/**
 * A completion counts as "drawn" if the task came out of the deck recently.
 * A warm-up deal (#57) also stamps last_drawn_at, but that card was handed
 * out, not gambled: when the stamp IS the last warm-up deal of this very
 * task, the heuristic must not turn it into the drawn ×1.5 — e.g. the dealt
 * card was snoozed (marker gone) and later completed from the Tasks page. A
 * later REGULAR draw re-stamps last_drawn_at with a different timestamp, so
 * the exact-match comparison reinstates the bonus only for a real gamble.
 */
export function wasRecentlyDrawn(task: TaskRow): boolean {
  if (!task.last_drawn_at) return false;
  const hours = (Date.now() - new Date(task.last_drawn_at).getTime()) / 3_600_000;
  if (hours >= 6) return false;
  const lastWarmup = getLastWarmupDeal();
  return !(
    lastWarmup != null &&
    lastWarmup.taskId === task.id &&
    lastWarmup.dealtAt === task.last_drawn_at
  );
}

/** Why a completion paid MORE than its plain XP (#57) — null when it didn't. */
export type CompletionBonus = "warmup" | "momentum" | null;

export interface CompletionResult {
  xpAwarded: number;
  bonus: CompletionBonus;
  newAchievements: string[];
  recurring: boolean;
  levelUp: boolean;
}

/**
 * The single effective XP multiplier (#57, ADR-30). Invariant: never above
 * the drawn ×1.5, and a warm-up strictly below it.
 *
 * - Warm-up card: NEVER the drawn ×1.5, even though it is the persisted
 *   current draw — it was handed out, not gambled. In its bonus window
 *   ×1.25, late ×1.0. Momentum never applies to the warm-up itself, keeping
 *   every warm-up multiplier at most ×1.25 < ×1.5, so warm-ups cannot become
 *   the XP meta.
 * - Any other card: drawn ×1.5, momentum ×1.25, combined but CAPPED at ×1.5
 *   total — a drawn card already at ×1.5 gains nothing from momentum, by
 *   design; momentum mainly rewards knocking out a non-drawn card while warm.
 *
 * `bonus` names the reason the XP is HIGHER than it would otherwise be:
 * "warmup" only when the window ×1.25 applied, "momentum" only when it
 * actually raised the multiplier (i.e. not on an already-×1.5 drawn card).
 */
export function xpMultiplier(input: {
  wasDrawn: boolean;
  warmup: { inWindow: boolean } | null;
  momentum: boolean;
}): { multiplier: number; bonus: CompletionBonus } {
  if (input.warmup) {
    return input.warmup.inWindow ? { multiplier: 1.25, bonus: "warmup" } : { multiplier: 1, bonus: null };
  }
  const multiplier = Math.min((input.wasDrawn ? 1.5 : 1) * (input.momentum ? 1.25 : 1), 1.5);
  return { multiplier, bonus: input.momentum && !input.wasDrawn ? "momentum" : null };
}

/**
 * Momentum (#57): a warm-up completion of a DIFFERENT task within the last 30
 * minutes. Derived from the completions log, never from stored state (ADR-2):
 * reopening the warm-up deletes its completion via undoLatestCompletion, which
 * disarms momentum automatically. Both timestamps are UTC ISO strings, so the
 * comparison stays in one format (SQLite datetime() would emit the space-
 * separated form, which does not compare against ISO "T" strings).
 */
function hasMomentum(taskId: number, now: Date): boolean {
  const cutoff = new Date(now.getTime() - 30 * 60_000).toISOString();
  return Boolean(
    db
      .prepare(
        "SELECT 1 FROM completions WHERE was_warmup = 1 AND task_id != ? AND completed_at >= ? LIMIT 1",
      )
      .get(taskId, cutoff),
  );
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export interface CompleteOptions {
  /**
   * Explicit effort override (#111, ADR-32): a parent with >= 1 non-archived
   * subtask completes at effort 0 — its subtasks already earned the effort
   * XP, and the `effort_minutes ?? 10` default would double-earn (or mint 10
   * minutes of XP for an unestimated parent). The `xp < 1` floor below lifts
   * the zero base to the symbolic 1 XP, keeping every completion row
   * uniformly >= 1 for the trophy/today displays. The override also forces
   * the warm-up branch off, for the same honesty reason as the caller-forced
   * `wasDrawn: false` — see the marker read below.
   */
  effortMinutes?: number;
}

/**
 * Complete a task: award XP, log the completion, and either close the task
 * or (recurring) push its due date forward. Must run inside a transaction.
 */
export function completeTask(
  task: TaskRow,
  wasDrawn: boolean,
  opts?: CompleteOptions,
): CompletionResult {
  const now = new Date();
  // Read the warm-up marker BEFORE clearCurrentDraw below wipes it. The
  // marker only ever describes the current draw, so a matching taskId means
  // this completion resolves the dealt warm-up card. The effort override
  // skips the read entirely (#111): a symbolic zero-effort completion never
  // resolves the deal — a dealt card that was broken down auto-completes
  // through here while the marker still points at it (POST /:id/subtasks
  // leaves the pointer for ADR-13's lazy clear), and recording was_warmup = 1
  // on that row would lie in the log and arm the ×1.25 momentum window off a
  // completion the user never made on the dealt card.
  const marker = opts?.effortMinutes == null ? getWarmupMarker() : null;
  const warmup =
    marker != null && marker.taskId === task.id
      ? {
          inWindow:
            now.getTime() <=
            new Date(marker.dealtAt).getTime() + marker.windowMinutes * 60_000,
        }
      : null;
  const momentum = !warmup && hasMomentum(task.id, now);
  const { multiplier, bonus } = xpMultiplier({ wasDrawn, warmup, momentum });

  const effort = opts?.effortMinutes ?? task.effort_minutes ?? 10;
  // Same shape as ever: rounded base, single effective multiplier, round,
  // floor 1 — multiplier 1.5 reproduces the historical drawn values exactly.
  let xp = Math.round(Math.round(effort * (task.impact / 3)) * multiplier);
  if (xp < 1) xp = 1;

  const levelBefore = levelFromXp(totalXp()).level;

  db.prepare(
    "INSERT INTO completions (task_id, completed_at, was_drawn, was_warmup, xp_awarded) VALUES (?, ?, ?, ?, ?)",
  ).run(task.id, now.toISOString(), wasDrawn ? 1 : 0, warmup ? 1 : 0, xp);

  // Completing ends the work session: close this task's own running timer at
  // completion time. A different task's running timer stays untouched. This
  // applies on the recurring path too — the task stays open, but XP was just
  // awarded for the session, so the entry is finished (ADR-12).
  db.prepare("UPDATE time_entries SET ended_at = ? WHERE task_id = ? AND ended_at IS NULL").run(
    now.toISOString(),
    task.id,
  );

  // Completion clears snooze/block state (ADR-17) — critical for recurring
  // tasks, which stay open and must be drawable for the next occurrence.
  const recurring = task.recur_every_days != null && task.recur_every_days > 0;
  if (recurring) {
    const next = new Date(now);
    next.setDate(next.getDate() + task.recur_every_days!);
    db.prepare(
      "UPDATE tasks SET due_date = ?, deferred_until = NULL, blocked = 0 WHERE id = ?",
    ).run(isoDate(next), task.id);
  } else {
    db.prepare(
      "UPDATE tasks SET status = 'done', completed_at = ?, deferred_until = NULL, blocked = 0 WHERE id = ?",
    ).run(now.toISOString(), task.id);
  }

  // A completed card leaves the deck: drop the persisted current draw if it
  // was this task (ADR-13). Recurring too — the task stays open, but the
  // drawn session just ended, matching how the client dismisses the card.
  clearCurrentDraw(task.id);

  // Freeze token earn (#58, ADR-28): the 7th/14th/... REAL completion day of
  // the unbroken run banks one token, capped at FREEZE_BANK_CAP unconsumed.
  // shouldEarnFreeze's milestone-day check plus the UNIQUE(milestone_day)
  // constraint make the earn idempotent — undo/redo cannot farm tokens.
  const earnDay = localDate(now);
  if (shouldEarnFreeze(streakState(), earnedFreezeDays(), earnDay)) {
    db.prepare(
      "INSERT OR IGNORE INTO streak_freezes (milestone_day, created_at) VALUES (?, ?)",
    ).run(earnDay, now.toISOString());
  }

  const levelAfter = levelFromXp(totalXp()).level;
  const newAchievements = checkAchievements({ completedTask: task });

  return { xpAwarded: xp, bonus, newAchievements, recurring, levelUp: levelAfter > levelBefore };
}

// ---------------------------------------------------------------------------
// XP / levels — always derived from completions, never stored.

// XP has TWO stored sources since #156 (ADR-42, amending ADR-5): the
// completions log (as ever) plus claimed achievements. Both are honest event
// facts — a claim is a one-time payout, guarded idempotent by the achievements
// primary key — so summing them stays within the "derive from logs, never a
// stored counter" spirit: there is still no `xp` column anywhere.
function totalXp(): number {
  const row = db
    .prepare(
      `SELECT COALESCE((SELECT SUM(xp_awarded) FROM completions), 0)
            + COALESCE((SELECT SUM(claim_xp) FROM achievements), 0) AS xp`,
    )
    .get() as { xp: number };
  return row.xp;
}

/** XP needed to advance from level n to n+1: 100 * n^1.5 */
export function levelFromXp(xp: number): { level: number; intoLevel: number; needed: number } {
  let level = 1;
  let remaining = xp;
  for (;;) {
    const needed = Math.round(100 * Math.pow(level, 1.5));
    if (remaining < needed) return { level, intoLevel: remaining, needed };
    remaining -= needed;
    level++;
  }
}

// ---------------------------------------------------------------------------
// Streak — real completion days (local server time) in an unbroken run.
// Rest weekdays and freeze-covered days neither break nor extend (#58,
// ADR-28). Fully derived on every read: completions log + rest setting +
// append-only freeze earn log feed the pure fold in streak.ts — no stored
// counter anywhere (ADR-2/ADR-5), and reads have no write side effects.

function completionDays(): Set<string> {
  const rows = db
    .prepare("SELECT DISTINCT date(completed_at, 'localtime') AS day FROM completions")
    .all() as { day: string }[];
  return new Set(rows.map((r) => r.day));
}

function restWeekdays(): Set<number> {
  const raw = getSettingString(REST_WEEKDAYS_SETTING);
  if (!raw) return new Set();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      const days = new Set(
        parsed.filter((d): d is number => Number.isInteger(d) && d >= 0 && d <= 6),
      );
      // All 7 never passes PATCH validation; a hand-edited row must not turn
      // every missed day into a rest day, so fall back to "no rest days".
      if (days.size < 7) return days;
    }
  } catch {
    // malformed setting value — behave like the default
  }
  return new Set();
}

/** Milestone days of earned tokens, chronological (the fold replays by day). */
function earnedFreezeDays(): string[] {
  const rows = db
    .prepare("SELECT milestone_day AS day FROM streak_freezes ORDER BY milestone_day")
    .all() as { day: string }[];
  return rows.map((r) => r.day);
}

export function streakState(): StreakState {
  return computeStreak({
    completionDays: completionDays(),
    restWeekdays: restWeekdays(),
    earnedFreezeDays: earnedFreezeDays(),
    today: localDate(new Date()),
  });
}

export function currentStreak(): number {
  return streakState().streak;
}

// ---------------------------------------------------------------------------
// Achievements

export interface AchievementDef {
  /* Typed against shared/achievementKeys.ts rather than `string` (#124): the
     client tiers achievements by key for rarity, so a definition added here
     with an unlisted key fails this typecheck — which in turn forces the key
     into the shared list, which forces the client to give it a tier. */
  key: AchievementKey;
  title: string;
  emoji: string;
  description: string;
}

// Display order matches shared/achievementKeys.ts. Most keys form a chain
// (#156): each level is its own achievement, tiered in shared/achievementTiers
// and progress-tracked below. Streak thresholds count REAL completion days
// (#58): rest and frozen days keep the run alive but never increment it, so 7
// completed days may span more than 7 calendar days. Already-unlocked rows stay
// unlocked — the achievements table is append-only.
export const ACHIEVEMENTS: AchievementDef[] = [
  // Draws chain — non-warmup deals only (ADR-30).
  { key: "first_draw", title: "First draw", emoji: "🃏", description: "Draw your first card." },
  { key: "draw_10", title: "Warming the deck", emoji: "🎴", description: "Draw 10 cards." },
  { key: "draw_100", title: "Seasoned drawer", emoji: "🃏", description: "Draw 100 cards." },
  { key: "draw_1000", title: "Deck devotee", emoji: "🎴", description: "Draw 1,000 cards." },
  { key: "draw_10000", title: "Ten thousand draws", emoji: "🎇", description: "Draw 10,000 cards." },
  // Completions chain.
  { key: "first_completion", title: "Off the mark", emoji: "✅", description: "Complete your first task." },
  { key: "complete_25", title: "Getting things done", emoji: "☑️", description: "Complete 25 tasks." },
  { key: "complete_100", title: "Centurion", emoji: "💯", description: "Complete 100 tasks." },
  { key: "complete_500", title: "Task machine", emoji: "⚙️", description: "Complete 500 tasks." },
  { key: "complete_2500", title: "Unrelenting", emoji: "🏅", description: "Complete 2,500 tasks." },
  // Streak chain.
  { key: "streak_7", title: "One week strong", emoji: "🔥", description: "7 completed days in one unbroken streak." },
  { key: "streak_30", title: "Unstoppable", emoji: "🌋", description: "30 completed days in one unbroken streak." },
  { key: "streak_100", title: "Hundred-day fire", emoji: "☄️", description: "100 completed days in one unbroken streak." },
  // Level chain.
  { key: "level_5", title: "Level 5", emoji: "⭐", description: "Reach level 5." },
  { key: "level_10", title: "Level 10", emoji: "🌟", description: "Reach level 10." },
  { key: "level_25", title: "Level 25", emoji: "💫", description: "Reach level 25." },
  { key: "level_50", title: "Level 50", emoji: "🌠", description: "Reach level 50." },
  // Goals-achieved chain.
  { key: "first_goal", title: "Goal getter", emoji: "🏆", description: "Achieve a goal." },
  { key: "goals_5", title: "Five and thriving", emoji: "🥅", description: "Achieve 5 goals." },
  { key: "goals_25", title: "Goal crusher", emoji: "🎖️", description: "Achieve 25 goals." },
  // Tracked-time chain.
  { key: "hours_10", title: "Ten hours in", emoji: "⏱️", description: "Track 10 hours of focused work." },
  { key: "hours_100", title: "Hundred hours deep", emoji: "⏳", description: "Track 100 hours of focused work." },
  { key: "hours_1000", title: "Thousand-hour master", emoji: "🕰️", description: "Track 1,000 hours of focused work." },
  // One-offs — no running total, so no progress bar.
  { key: "monster_slayer", title: "Monster slayer", emoji: "🐉", description: "Finish every subtask of a big task." },
  { key: "leverage_master", title: "Leverage master", emoji: "🎯", description: "60% of a week's time on 4–5★ tasks." },
  { key: "deck_clearer", title: "Deck clearer", emoji: "🏜", description: "Empty the drawable deck by completing it." },
  { key: "early_bird", title: "Early bird", emoji: "🐦", description: "Finish a 5★ task before its due date." },
];

// ---------------------------------------------------------------------------
// Chains (#156). Each chain level unlocks when a single running metric crosses
// a threshold. The SAME table drives both the unlock condition (met when the
// metric ≥ target) and the progress bar (current/target), so the two can never
// disagree — a bar that reads full is a card that unlocks. One-offs are absent
// here: they have no meaningful running total, and gamificationState reports
// their progress as null.
type ChainMetric = "draws" | "completions" | "streak" | "level" | "goals" | "hours";

interface ChainSpec {
  metric: ChainMetric;
  target: number;
}

const CHAIN_SPECS: Partial<Record<AchievementKey, ChainSpec>> = {
  first_draw: { metric: "draws", target: 1 },
  draw_10: { metric: "draws", target: 10 },
  draw_100: { metric: "draws", target: 100 },
  draw_1000: { metric: "draws", target: 1000 },
  draw_10000: { metric: "draws", target: 10000 },
  first_completion: { metric: "completions", target: 1 },
  complete_25: { metric: "completions", target: 25 },
  complete_100: { metric: "completions", target: 100 },
  complete_500: { metric: "completions", target: 500 },
  complete_2500: { metric: "completions", target: 2500 },
  streak_7: { metric: "streak", target: 7 },
  streak_30: { metric: "streak", target: 30 },
  streak_100: { metric: "streak", target: 100 },
  level_5: { metric: "level", target: 5 },
  level_10: { metric: "level", target: 10 },
  level_25: { metric: "level", target: 25 },
  level_50: { metric: "level", target: 50 },
  first_goal: { metric: "goals", target: 1 },
  goals_5: { metric: "goals", target: 5 },
  goals_25: { metric: "goals", target: 25 },
  hours_10: { metric: "hours", target: 10 },
  hours_100: { metric: "hours", target: 100 },
  hours_1000: { metric: "hours", target: 1000 },
};

function unlockedKeys(): Set<string> {
  const rows = db.prepare("SELECT key FROM achievements").all() as { key: string }[];
  return new Set(rows.map((r) => r.key));
}

// Deliberately does NOT apply the snooze/block predicate (ADR-17): the
// deck_clearer achievement must keep counting snoozed/blocked cards, or
// snoozing the rest of the deck and completing one task would unlock it.
function drawableCount(): number {
  const maxEffort = getSetting("max_draw_effort", 30);
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM tasks t
       WHERE t.status = 'open' AND t.effort_minutes IS NOT NULL AND t.effort_minutes <= ?
         AND NOT EXISTS(SELECT 1 FROM tasks c WHERE c.parent_id = t.id AND c.status != 'archived')`,
    )
    .get(maxEffort) as { n: number };
  return row.n;
}

// The running totals every chain level (#156) is measured against. Computed
// once per check, then compared to each level's target. `draws` counts
// NON-WARMUP rows only (ADR-30): a warm-up card was handed out, not gambled, so
// it never advances the draws chain. `hours` is whole CLOSED tracked hours.
interface Metrics {
  draws: number;
  completions: number;
  streak: number;
  level: number;
  goals: number;
  hours: number;
}

function nonWarmupDrawCount(): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM draws WHERE was_warmup = 0").get() as { n: number })
    .n;
}

function achievedGoalCount(): number {
  return (
    db.prepare("SELECT COUNT(*) AS n FROM goals WHERE status = 'achieved'").get() as { n: number }
  ).n;
}

/** Whole tracked hours from CLOSED time_entries (the codebase's closed-only
 *  convention) — floored so the progress bar and the unlock threshold agree
 *  exactly (10 shown means 10 reached). */
function trackedHours(): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM((julianday(ended_at) - julianday(started_at)) * 1440.0), 0) AS minutes
       FROM time_entries WHERE ended_at IS NOT NULL`,
    )
    .get() as { minutes: number };
  // Round the float sum to whole minutes before flooring to hours: julianday
  // arithmetic makes an exact 600 minutes read as 599.9999997, which would
  // floor to 9h and miss the threshold by a rounding artefact. Rounding to the
  // nearest minute (the metric's natural granularity) recovers the true count.
  return Math.floor(Math.round(row.minutes) / 60);
}

function computeMetrics(): Metrics {
  return {
    draws: nonWarmupDrawCount(),
    completions: (db.prepare("SELECT COUNT(*) AS n FROM completions").get() as { n: number }).n,
    streak: currentStreak(),
    level: levelFromXp(totalXp()).level,
    goals: achievedGoalCount(),
    hours: trackedHours(),
  };
}

/** Progress {current, target} for a chain key, or null for a one-off. current
 *  is capped at target so an unlocked card reads as a full bar rather than an
 *  over-100% overshoot (52 draws is 1/1 on first_draw, not 52/1). */
function chainProgress(
  key: AchievementKey,
  metrics: Metrics,
): { current: number; target: number } | null {
  const spec = CHAIN_SPECS[key];
  if (!spec) return null;
  return { current: Math.min(metrics[spec.metric], spec.target), target: spec.target };
}

export function checkAchievements(event: { completedTask?: TaskRow; drew?: boolean }): string[] {
  const unlocked = unlockedKeys();
  const fresh: string[] = [];
  const metrics = computeMetrics();

  const conditions: Record<string, boolean> = {};

  // Every chain level unlocks off the same table that draws its progress bar,
  // so a full bar is always a real unlock. first_draw and first_completion are
  // just the target-1 heads of their chains — no special-casing.
  for (const [key, spec] of Object.entries(CHAIN_SPECS) as [AchievementKey, ChainSpec][]) {
    conditions[key] = metrics[spec.metric] >= spec.target;
  }

  // One-offs — event- or week-shaped, with no running total.
  conditions.monster_slayer = Boolean(
    event.completedTask &&
      (
        db
          .prepare("SELECT COUNT(*) AS n FROM tasks WHERE parent_id = ? AND status = 'done'")
          .get(event.completedTask.id) as { n: number }
      ).n >= 2,
  );
  conditions.deck_clearer =
    Boolean(event.completedTask) && metrics.completions >= 3 && drawableCount() === 0;
  conditions.early_bird = Boolean(
    event.completedTask &&
      event.completedTask.impact === 5 &&
      event.completedTask.due_date &&
      isoDate(new Date()) <= event.completedTask.due_date,
  );

  // leverage_master is evaluated by statsService weekly-grade logic at read
  // time; unlocking it here would need the same aggregation — check cheaply:
  const week = db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN t.impact >= 4 THEN (julianday(COALESCE(e.ended_at, strftime('%Y-%m-%dT%H:%M:%fZ','now'))) - julianday(e.started_at)) END), 0) * 1440.0 AS high,
         COALESCE(SUM((julianday(COALESCE(e.ended_at, strftime('%Y-%m-%dT%H:%M:%fZ','now'))) - julianday(e.started_at))), 0) * 1440.0 AS total
       FROM time_entries e JOIN tasks t ON t.id = e.task_id
       WHERE e.started_at >= datetime('now', '-7 days')`,
    )
    .get() as { high: number; total: number };
  conditions.leverage_master = week.total >= 60 && week.high / week.total >= 0.6;

  const insert = db.prepare("INSERT INTO achievements (key, unlocked_at) VALUES (?, ?)");
  for (const [key, met] of Object.entries(conditions)) {
    if (met && !unlocked.has(key)) {
      insert.run(key, new Date().toISOString());
      fresh.push(key);
    }
  }
  return fresh;
}

// ---------------------------------------------------------------------------
// State for GET /api/gamification

export function gamificationState() {
  const xp = totalXp();
  const { level, intoLevel, needed } = levelFromXp(xp);
  const streakInfo = streakState();
  const dailyGoal = getSetting("daily_goal_completions", 1);

  // Surfaced drawn-ness derives as was_drawn AND NOT was_warmup (ADR-30): a
  // warm-up deal was handed out, not gambled, so it must not mint the drawn
  // trophy rarity (#62) or the "(drawn)" label — the same distinction
  // completeTask() draws for the ×1.5. The row keeps both raw facts.
  // goalId rides the same live tasks join as title/impact (#115): the trophy
  // mini-frame shows level stars only for goal-linked completions (ADR-4) —
  // impact alone cannot tell a rated card from the neutral default 3.
  const todayCompletions = db
    .prepare(
      `SELECT co.id, co.completed_at AS completedAt,
              (co.was_drawn AND NOT co.was_warmup) AS wasDrawn, co.xp_awarded AS xpAwarded,
              t.id AS taskId, t.title, t.category_id AS categoryId, t.goal_id AS goalId, t.impact
       FROM completions co JOIN tasks t ON t.id = co.task_id
       WHERE date(co.completed_at, 'localtime') = date('now', 'localtime')
       ORDER BY co.completed_at ASC`,
    )
    .all();

  const unlocked = db
    .prepare(
      "SELECT key, unlocked_at AS unlockedAt, claimed_at AS claimedAt, claim_xp AS claimXp FROM achievements",
    )
    .all() as { key: string; unlockedAt: string; claimedAt: string | null; claimXp: number | null }[];
  const unlockedMap = new Map(unlocked.map((u) => [u.key, u]));
  const metrics = computeMetrics();

  return {
    xp,
    level,
    levelProgress: { intoLevel, needed },
    // streak stays a plain number for compatibility; the sibling fields let
    // the client render rest/frozen days honestly (#58) — never as completed.
    streak: streakInfo.streak,
    todayKind: streakInfo.todayKind,
    freezesBanked: streakInfo.freezesBanked,
    freezeBankCap: FREEZE_BANK_CAP,
    frozenDays: streakInfo.frozenDays,
    restDays: streakInfo.restDays,
    dailyGoalMet: todayCompletions.length >= dailyGoal,
    dailyGoal,
    todayCompletions,
    // Each card carries its unlock/claim state plus chain progress (#156):
    // {current, target} for a chain level, null for a one-off. claimXp is the
    // stamped payout once claimed; the client shows the prospective value from
    // the shared tier table until then.
    achievements: ACHIEVEMENTS.map((a) => {
      const row = unlockedMap.get(a.key);
      return {
        ...a,
        unlockedAt: row?.unlockedAt ?? null,
        claimedAt: row?.claimedAt ?? null,
        claimXp: row?.claimXp ?? null,
        progress: chainProgress(a.key, metrics),
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// Claim-for-XP (#156, ADR-42)

export type ClaimResult =
  | { status: "ok"; xpAwarded: number; levelUp: boolean }
  | { status: "unknown" } // not a real achievement key → 400
  | { status: "locked" } // real key, but not unlocked yet → 400
  | { status: "claimed" }; // already claimed → 409

/**
 * Claim an unlocked achievement for rarity-scaled XP, ONCE ever. Idempotent by
 * the achievements primary key: the guarded UPDATE (`claimed_at IS NULL`) plus
 * the pre-read make a second claim a no-op that reports "claimed". claim_xp is
 * stamped from the SERVER tier table — the client is never the XP authority.
 * levelUp compares the derived level across the payout, so a claim that tips
 * the bar over surfaces the same level-up the client already animates.
 */
export function claimAchievement(key: string): ClaimResult {
  if (!(ACHIEVEMENT_KEYS as readonly string[]).includes(key)) return { status: "unknown" };
  return db.transaction((): ClaimResult => {
    const row = db.prepare("SELECT claimed_at AS claimedAt FROM achievements WHERE key = ?").get(key) as
      | { claimedAt: string | null }
      | undefined;
    if (!row) return { status: "locked" };
    if (row.claimedAt != null) return { status: "claimed" };

    const xpAwarded = claimXpForKey(key);
    const levelBefore = levelFromXp(totalXp()).level;
    db.prepare(
      "UPDATE achievements SET claimed_at = ?, claim_xp = ? WHERE key = ? AND claimed_at IS NULL",
    ).run(new Date().toISOString(), xpAwarded, key);
    const levelAfter = levelFromXp(totalXp()).level;
    return { status: "ok", xpAwarded, levelUp: levelAfter > levelBefore };
  })();
}

/** Reopening a task removes its latest completion so XP can't be farmed. */
export function undoLatestCompletion(taskId: number) {
  db.prepare(
    "DELETE FROM completions WHERE id = (SELECT id FROM completions WHERE task_id = ? ORDER BY completed_at DESC LIMIT 1)",
  ).run(taskId);
}
