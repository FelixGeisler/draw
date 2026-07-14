import {
  CURRENT_DRAW_SETTING,
  db,
  deleteSetting,
  getSetting,
  getSettingString,
  setSetting,
} from "../db.js";

export interface Candidate {
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

export function urgencyFactor(dueDate: string | null, now: Date): number {
  if (!dueDate) return 1;
  const due = new Date(`${dueDate}T23:59:59`);
  const daysLeft = (due.getTime() - now.getTime()) / DAY_MS;
  if (daysLeft < 0) return 5; // overdue
  if (daysLeft >= 7) return 1;
  // ramp x1 -> x4 over the final 7 days
  return 1 + (3 * (7 - daysLeft)) / 7;
}

export function stalenessFactor(candidate: Candidate, now: Date): number {
  const since =
    candidate.recurEveryDays != null && candidate.lastCompletedAt
      ? new Date(candidate.lastCompletedAt)
      : new Date(candidate.createdAt);
  const days = Math.max(0, (now.getTime() - since.getTime()) / DAY_MS);
  return 1 + Math.min(days, 30) / 30; // up to x2
}

export function weight(c: Candidate, now: Date, cooldownMinutes: number, poolSize: number): number {
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
    // The draw replaced whatever card was showing — even an empty draw, so a
    // reload doesn't resurrect a card the user already saw disappear.
    clearCurrentDraw();
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
  // Persist the draw so a page reload restores the card (ADR-13) — a new
  // draw simply overwrites the previous one.
  setSetting(CURRENT_DRAW_SETTING, String(chosen.id));

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

// ---------------------------------------------------------------------------
// Current draw — the drawn card persisted across reloads (ADR-13), restored
// by the DrawPage the same way the TimerBar restores the running timer.

export interface RestorableTask {
  status: string;
  effortMinutes: number | null;
  hasOpenChildren: number;
}

/**
 * Restore-validation for a persisted draw. Mirrors the client's
 * `classifyTask` and the candidate WHERE clause above: only an open leaf
 * task with an estimate within the draw limit is still in the deck.
 */
export function isRestorable(task: RestorableTask, maxEffort: number): boolean {
  return (
    task.status === "open" &&
    !task.hasOpenChildren &&
    task.effortMinutes != null &&
    task.effortMinutes <= maxEffort
  );
}

export function getCurrentDrawTaskId(): number | null {
  const raw = getSettingString(CURRENT_DRAW_SETTING);
  return raw == null ? null : Number(raw);
}

/** Clear the persisted draw — unconditionally, or only if it matches taskId. */
export function clearCurrentDraw(taskId?: number) {
  if (taskId === undefined || getCurrentDrawTaskId() === taskId) {
    deleteSetting(CURRENT_DRAW_SETTING);
  }
}

/**
 * The persisted current draw, for restore after a reload. A pointer that went
 * stale sideways (task deleted with its parent, completed elsewhere, edited
 * out of the deck) is cleared lazily here and null is returned.
 */
export function currentDraw(): { task: Record<string, unknown> } | null {
  const id = getCurrentDrawTaskId();
  if (id == null) return null;

  const task = db
    .prepare(
      `SELECT t.id, t.title, t.description,
              t.category_id AS categoryId, t.goal_id AS goalId, t.parent_id AS parentId,
              t.impact, t.effort_minutes AS effortMinutes, t.due_date AS dueDate,
              t.recur_every_days AS recurEveryDays, t.status,
              t.created_at AS createdAt, t.completed_at AS completedAt,
              t.last_drawn_at AS lastDrawnAt,
              EXISTS(SELECT 1 FROM tasks c WHERE c.parent_id = t.id AND c.status = 'open') AS hasOpenChildren
       FROM tasks t WHERE t.id = ?`,
    )
    .get(id) as (Record<string, unknown> & RestorableTask) | undefined;

  const maxEffort = getSetting("max_draw_effort", 30);
  if (!task || !isRestorable(task, maxEffort)) {
    clearCurrentDraw();
    return null;
  }
  return { task };
}
