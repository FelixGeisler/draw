import { db, getSetting } from "../db.js";

interface Candidate {
  id: number;
  impact: number;
  effortMinutes: number;
  dueDate: string | null;
  createdAt: string;
  recurEveryDays: number | null;
  lastDrawnAt: string | null;
  lastCompletedAt: string | null;
}

export interface DrawResult {
  task: Record<string, unknown> | null;
  reason?: "no_ready_tasks" | "all_too_big";
  poolSize?: number;
  probability?: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function urgencyFactor(dueDate: string | null, now: Date): number {
  if (!dueDate) return 1;
  const due = new Date(`${dueDate}T23:59:59`);
  const daysLeft = (due.getTime() - now.getTime()) / DAY_MS;
  if (daysLeft < 0) return 5; // overdue
  if (daysLeft >= 7) return 1;
  // ramp x1 -> x4 over the final 7 days
  return 1 + (3 * (7 - daysLeft)) / 7;
}

function stalenessFactor(candidate: Candidate, now: Date): number {
  const since =
    candidate.recurEveryDays != null && candidate.lastCompletedAt
      ? new Date(candidate.lastCompletedAt)
      : new Date(candidate.createdAt);
  const days = Math.max(0, (now.getTime() - since.getTime()) / DAY_MS);
  return 1 + Math.min(days, 30) / 30; // up to x2
}

function weight(c: Candidate, now: Date, cooldownMinutes: number, poolSize: number): number {
  let w = (c.impact * c.impact) / Math.max(c.effortMinutes, 5);
  w *= urgencyFactor(c.dueDate, now);
  w *= stalenessFactor(c, now);
  if (poolSize > 1 && c.lastDrawnAt) {
    const minutesSinceDrawn = (now.getTime() - new Date(c.lastDrawnAt).getTime()) / 60_000;
    if (minutesSinceDrawn < cooldownMinutes) w *= 0.15;
  }
  return w;
}

export function drawTask(filters: { categoryId?: number; goalId?: number }): DrawResult {
  const maxEffort = getSetting("max_draw_effort", 30);
  const cooldown = getSetting("draw_cooldown_minutes", 60);
  const now = new Date();

  const conditions = [
    "t.status = 'open'",
    "t.effort_minutes IS NOT NULL",
    "t.effort_minutes <= ?",
    "NOT EXISTS(SELECT 1 FROM tasks c WHERE c.parent_id = t.id AND c.status = 'open')",
  ];
  const params: unknown[] = [maxEffort];
  if (filters.categoryId) {
    conditions.push("t.category_id = ?");
    params.push(filters.categoryId);
  }
  if (filters.goalId) {
    conditions.push("t.goal_id = ?");
    params.push(filters.goalId);
  }

  const candidates = db
    .prepare(
      `SELECT t.id, t.impact, t.effort_minutes AS effortMinutes, t.due_date AS dueDate,
              t.created_at AS createdAt, t.recur_every_days AS recurEveryDays,
              t.last_drawn_at AS lastDrawnAt,
              (SELECT MAX(completed_at) FROM completions WHERE task_id = t.id) AS lastCompletedAt
       FROM tasks t WHERE ${conditions.join(" AND ")}`,
    )
    .all(...params) as Candidate[];

  if (candidates.length === 0) {
    // Distinguish "nothing at all" from "only oversized/unestimated tasks".
    const anyOpen = db
      .prepare(
        `SELECT COUNT(*) AS n FROM tasks t
         WHERE t.status = 'open'
           AND NOT EXISTS(SELECT 1 FROM tasks c WHERE c.parent_id = t.id AND c.status = 'open')
           ${filters.categoryId ? "AND t.category_id = ?" : ""}
           ${filters.goalId ? "AND t.goal_id = ?" : ""}`,
      )
      .get(...params.slice(1)) as { n: number };
    return { task: null, reason: anyOpen.n > 0 ? "all_too_big" : "no_ready_tasks" };
  }

  const weights = candidates.map((c) => weight(c, now, cooldown, candidates.length));
  const total = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  let picked = candidates.length - 1;
  for (let i = 0; i < candidates.length; i++) {
    r -= weights[i];
    if (r <= 0) {
      picked = i;
      break;
    }
  }

  const chosen = candidates[picked];
  db.prepare("UPDATE tasks SET last_drawn_at = ? WHERE id = ?").run(now.toISOString(), chosen.id);

  const task = db
    .prepare(
      `SELECT t.id, t.title, t.description,
              t.category_id AS categoryId, t.goal_id AS goalId, t.parent_id AS parentId,
              t.impact, t.effort_minutes AS effortMinutes, t.due_date AS dueDate,
              t.recur_every_days AS recurEveryDays, t.status,
              t.created_at AS createdAt, t.completed_at AS completedAt,
              t.last_drawn_at AS lastDrawnAt,
              0 AS hasOpenChildren
       FROM tasks t WHERE t.id = ?`,
    )
    .get(chosen.id) as Record<string, unknown>;

  return {
    task,
    poolSize: candidates.length,
    probability: weights[picked] / total,
  };
}
