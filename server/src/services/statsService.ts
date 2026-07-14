import { db } from "../db.js";

export interface Stats {
  totalMinutes: number;
  byCategory: { categoryId: number; name: string; color: string; minutes: number }[];
  byImpact: { impact: number; minutes: number }[];
  byGoal: { goalId: number; title: string; minutes: number }[];
  completed: { count: number; avgEffortMinutes: number | null };
  leverageInsights: string[];
  weeklyGrade: string | null;
}

/** Minutes per time entry, running entries counted up to now. */
const MINUTES_EXPR = `(julianday(COALESCE(e.ended_at, strftime('%Y-%m-%dT%H:%M:%fZ','now'))) - julianday(e.started_at)) * 1440.0`;

export function computeStats(from: string, to: string): Stats {
  // `to` is exclusive end-of-range (ISO date + 1 day handled by caller)
  const range = [from, to];

  const total = db
    .prepare(
      `SELECT COALESCE(SUM(${MINUTES_EXPR}), 0) AS minutes
       FROM time_entries e WHERE e.started_at >= ? AND e.started_at < ?`,
    )
    .get(...range) as { minutes: number };

  const byCategory = db
    .prepare(
      `SELECT c.id AS categoryId, c.name, c.color, SUM(${MINUTES_EXPR}) AS minutes
       FROM time_entries e JOIN tasks t ON t.id = e.task_id JOIN categories c ON c.id = t.category_id
       WHERE e.started_at >= ? AND e.started_at < ?
       GROUP BY c.id ORDER BY minutes DESC`,
    )
    .all(...range) as Stats["byCategory"];

  const byImpact = db
    .prepare(
      `SELECT t.impact, SUM(${MINUTES_EXPR}) AS minutes
       FROM time_entries e JOIN tasks t ON t.id = e.task_id
       WHERE e.started_at >= ? AND e.started_at < ?
       GROUP BY t.impact ORDER BY t.impact`,
    )
    .all(...range) as Stats["byImpact"];

  const byGoal = db
    .prepare(
      `SELECT g.id AS goalId, g.title, SUM(${MINUTES_EXPR}) AS minutes
       FROM time_entries e JOIN tasks t ON t.id = e.task_id JOIN goals g ON g.id = t.goal_id
       WHERE e.started_at >= ? AND e.started_at < ?
       GROUP BY g.id ORDER BY minutes DESC`,
    )
    .all(...range) as Stats["byGoal"];

  const completed = db
    .prepare(
      `SELECT COUNT(*) AS count, AVG(t.effort_minutes) AS avgEffortMinutes
       FROM completions co JOIN tasks t ON t.id = co.task_id
       WHERE co.completed_at >= ? AND co.completed_at < ?`,
    )
    .get(...range) as Stats["completed"];

  const totalMinutes = Math.round(total.minutes);
  const minutesAt = (pred: (impact: number) => boolean) =>
    byImpact.filter((r) => pred(r.impact)).reduce((a, r) => a + r.minutes, 0);

  const lowShare = totalMinutes > 0 ? minutesAt((i) => i <= 2) / total.minutes : 0;
  const highShare = totalMinutes > 0 ? minutesAt((i) => i >= 4) / total.minutes : 0;

  const leverageInsights: string[] = [];
  if (totalMinutes >= 30 && lowShare > 0.5) {
    leverageInsights.push(
      `⚠ ${Math.round(lowShare * 100)}% of your tracked time went to 1–2★ tasks. Is the intro chapter really where the marks are?`,
    );
  }
  if (totalMinutes >= 30 && highShare < 0.1) {
    leverageInsights.push(
      `Your 4–5★ tasks got only ${Math.round(minutesAt((i) => i >= 4))} min. Draw from the high-leverage pile first.`,
    );
  }
  if (totalMinutes >= 30 && highShare >= 0.6) {
    leverageInsights.push(
      `💪 ${Math.round(highShare * 100)}% of your time went to 4–5★ tasks. That's leverage.`,
    );
  }

  let weeklyGrade: string | null = null;
  if (totalMinutes >= 30) {
    weeklyGrade =
      highShare >= 0.6 ? "A" : highShare >= 0.45 ? "B" : highShare >= 0.3 ? "C" : highShare >= 0.15 ? "D" : "F";
  }

  return {
    totalMinutes,
    byCategory: byCategory.map((r) => ({ ...r, minutes: Math.round(r.minutes) })),
    byImpact: byImpact.map((r) => ({ ...r, minutes: Math.round(r.minutes) })),
    byGoal: byGoal.map((r) => ({ ...r, minutes: Math.round(r.minutes) })),
    completed: {
      count: completed.count,
      avgEffortMinutes: completed.avgEffortMinutes ? Math.round(completed.avgEffortMinutes) : null,
    },
    leverageInsights,
    weeklyGrade,
  };
}
