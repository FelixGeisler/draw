import { db, getSetting } from "../db.js";
import { clearCurrentDraw } from "./drawService.js";

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

/** A completion counts as "drawn" if the task came out of the deck recently. */
export function wasRecentlyDrawn(task: TaskRow): boolean {
  if (!task.last_drawn_at) return false;
  const hours = (Date.now() - new Date(task.last_drawn_at).getTime()) / 3_600_000;
  return hours < 6;
}

export interface CompletionResult {
  xpAwarded: number;
  newAchievements: string[];
  recurring: boolean;
  levelUp: boolean;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Complete a task: award XP, log the completion, and either close the task
 * or (recurring) push its due date forward. Must run inside a transaction.
 */
export function completeTask(task: TaskRow, wasDrawn: boolean): CompletionResult {
  const effort = task.effort_minutes ?? 10;
  let xp = Math.round(effort * (task.impact / 3));
  if (wasDrawn) xp = Math.round(xp * 1.5);
  if (xp < 1) xp = 1;

  const levelBefore = levelFromXp(totalXp()).level;

  const now = new Date();
  db.prepare(
    "INSERT INTO completions (task_id, completed_at, was_drawn, xp_awarded) VALUES (?, ?, ?, ?)",
  ).run(task.id, now.toISOString(), wasDrawn ? 1 : 0, xp);

  // Completing ends the work session: close this task's own running timer at
  // completion time. A different task's running timer stays untouched. This
  // applies on the recurring path too — the task stays open, but XP was just
  // awarded for the session, so the entry is finished (ADR-12).
  db.prepare("UPDATE time_entries SET ended_at = ? WHERE task_id = ? AND ended_at IS NULL").run(
    now.toISOString(),
    task.id,
  );

  // Completion clears snooze/block state (ADR-16) — critical for recurring
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

  const levelAfter = levelFromXp(totalXp()).level;
  const newAchievements = checkAchievements({ completedTask: task });

  return { xpAwarded: xp, newAchievements, recurring, levelUp: levelAfter > levelBefore };
}

// ---------------------------------------------------------------------------
// XP / levels — always derived from completions, never stored.

function totalXp(): number {
  const row = db.prepare("SELECT COALESCE(SUM(xp_awarded), 0) AS xp FROM completions").get() as {
    xp: number;
  };
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
// Streak — consecutive calendar days (local server time) with >= 1 completion.

function completionDays(): Set<string> {
  const rows = db
    .prepare("SELECT DISTINCT date(completed_at, 'localtime') AS day FROM completions")
    .all() as { day: string }[];
  return new Set(rows.map((r) => r.day));
}

export function currentStreak(): number {
  const days = completionDays();
  const cursor = new Date();
  let streak = 0;
  // Today counts if present, but doesn't break the streak if missing yet.
  if (days.has(localDate(cursor))) streak++;
  cursor.setDate(cursor.getDate() - 1);
  while (days.has(localDate(cursor))) {
    streak++;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}

function localDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Achievements

export interface AchievementDef {
  key: string;
  title: string;
  emoji: string;
  description: string;
}

export const ACHIEVEMENTS: AchievementDef[] = [
  { key: "first_draw", title: "First draw", emoji: "🃏", description: "Draw your first card." },
  { key: "first_completion", title: "Off the mark", emoji: "✅", description: "Complete your first task." },
  { key: "streak_7", title: "One week strong", emoji: "🔥", description: "A 7-day completion streak." },
  { key: "streak_30", title: "Unstoppable", emoji: "🌋", description: "A 30-day completion streak." },
  { key: "monster_slayer", title: "Monster slayer", emoji: "🐉", description: "Finish every subtask of a big task." },
  { key: "leverage_master", title: "Leverage master", emoji: "🎯", description: "60% of a week's time on 4–5★ tasks." },
  { key: "deck_clearer", title: "Deck clearer", emoji: "🏜", description: "Empty the drawable deck by completing it." },
  { key: "level_5", title: "Level 5", emoji: "⭐", description: "Reach level 5." },
  { key: "level_10", title: "Level 10", emoji: "🌟", description: "Reach level 10." },
  { key: "early_bird", title: "Early bird", emoji: "🐦", description: "Finish a 5★ task before its due date." },
];

function unlockedKeys(): Set<string> {
  const rows = db.prepare("SELECT key FROM achievements").all() as { key: string }[];
  return new Set(rows.map((r) => r.key));
}

function drawableCount(): number {
  const maxEffort = getSetting("max_draw_effort", 30);
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM tasks t
       WHERE t.status = 'open' AND t.effort_minutes IS NOT NULL AND t.effort_minutes <= ?
         AND NOT EXISTS(SELECT 1 FROM tasks c WHERE c.parent_id = t.id AND c.status = 'open')`,
    )
    .get(maxEffort) as { n: number };
  return row.n;
}

export function checkAchievements(event: { completedTask?: TaskRow; drew?: boolean }): string[] {
  const unlocked = unlockedKeys();
  const fresh: string[] = [];

  const completions = db.prepare("SELECT COUNT(*) AS n FROM completions").get() as { n: number };
  const streak = currentStreak();
  const level = levelFromXp(totalXp()).level;

  const conditions: Record<string, boolean> = {
    first_draw: Boolean(event.drew),
    first_completion: completions.n >= 1,
    streak_7: streak >= 7,
    streak_30: streak >= 30,
    monster_slayer: Boolean(
      event.completedTask &&
        (
          db
            .prepare(
              "SELECT COUNT(*) AS n FROM tasks WHERE parent_id = ? AND status = 'done'",
            )
            .get(event.completedTask.id) as { n: number }
        ).n >= 2,
    ),
    deck_clearer: Boolean(event.completedTask) && completions.n >= 3 && drawableCount() === 0,
    level_5: level >= 5,
    level_10: level >= 10,
    early_bird: Boolean(
      event.completedTask &&
        event.completedTask.impact === 5 &&
        event.completedTask.due_date &&
        isoDate(new Date()) <= event.completedTask.due_date,
    ),
  };

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
  const streak = currentStreak();
  const dailyGoal = getSetting("daily_goal_completions", 1);

  const todayCompletions = db
    .prepare(
      `SELECT co.id, co.completed_at AS completedAt, co.was_drawn AS wasDrawn, co.xp_awarded AS xpAwarded,
              t.id AS taskId, t.title, t.category_id AS categoryId, t.impact
       FROM completions co JOIN tasks t ON t.id = co.task_id
       WHERE date(co.completed_at, 'localtime') = date('now', 'localtime')
       ORDER BY co.completed_at ASC`,
    )
    .all();

  const unlocked = db.prepare("SELECT key, unlocked_at AS unlockedAt FROM achievements").all() as {
    key: string;
    unlockedAt: string;
  }[];
  const unlockedMap = new Map(unlocked.map((u) => [u.key, u.unlockedAt]));

  return {
    xp,
    level,
    levelProgress: { intoLevel, needed },
    streak,
    dailyGoalMet: todayCompletions.length >= dailyGoal,
    dailyGoal,
    todayCompletions,
    achievements: ACHIEVEMENTS.map((a) => ({
      ...a,
      unlockedAt: unlockedMap.get(a.key) ?? null,
    })),
  };
}

/** Reopening a task removes its latest completion so XP can't be farmed. */
export function undoLatestCompletion(taskId: number) {
  db.prepare(
    "DELETE FROM completions WHERE id = (SELECT id FROM completions WHERE task_id = ? ORDER BY completed_at DESC LIMIT 1)",
  ).run(taskId);
}
