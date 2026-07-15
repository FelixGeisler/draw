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
  deferredUntil: string | null;
}

export interface PoolCandidate extends Candidate {
  title: string;
  categoryId: number;
  goalId: number | null;
}

export interface DrawFilters {
  categoryId?: number;
  goalId?: number;
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
  const base =
    candidate.recurEveryDays != null && candidate.lastCompletedAt
      ? new Date(candidate.lastCompletedAt)
      : new Date(candidate.createdAt);
  // Snooze time is not "lying around": deferred_until is retained after expiry
  // (ADR-17), so a woken card's staleness counts from its wake time.
  const wake = candidate.deferredUntil ? new Date(candidate.deferredUntil) : null;
  const since = wake && wake > base ? wake : base;
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

// Snooze/block (ADR-17): kept as a derived predicate alongside the rest —
// an expired deferred_until re-enters the pool with no write.
const SNOOZE_CONDITION = "t.blocked = 0 AND (t.deferred_until IS NULL OR t.deferred_until <= ?)";

/**
 * Derived hold-back predicate (#23, ADR-18): the task sits behind an older
 * open sibling under a 'sequential' parent. Creation order is
 * (created_at, id) — the order the Tasks page renders and the AI breakdown
 * emits; the id tie-break keeps batch-inserted siblings (identical
 * created_at) deterministic. Like snoozing, this is never a stored flag:
 * completing the older sibling frees the next one with no write.
 */
export function heldBackSql(alias: string): string {
  return `EXISTS(
    SELECT 1 FROM tasks p JOIN tasks s ON s.parent_id = p.id
    WHERE p.id = ${alias}.parent_id AND p.subtask_order_mode = 'sequential'
      AND s.status = 'open'
      AND (s.created_at < ${alias}.created_at OR (s.created_at = ${alias}.created_at AND s.id < ${alias}.id))
  )`;
}

function filterConditions(filters: DrawFilters): { conditions: string[]; params: unknown[] } {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (filters.categoryId) {
    conditions.push("t.category_id = ?");
    params.push(filters.categoryId);
  }
  if (filters.goalId) {
    conditions.push("t.goal_id = ?");
    params.push(filters.goalId);
  }
  return { conditions, params };
}

/**
 * The drawable-candidate query — the single home of the drawability
 * predicate (ADR-2). Reused by drawTask() and the side-effect-free
 * drawPool() below so the two can never drift.
 */
function queryCandidates(filters: DrawFilters, maxEffort: number, now: Date): PoolCandidate[] {
  const filter = filterConditions(filters);
  const conditions = [
    "t.status = 'open'",
    "t.effort_minutes IS NOT NULL",
    "t.effort_minutes <= ?",
    SNOOZE_CONDITION,
    "NOT EXISTS(SELECT 1 FROM tasks c WHERE c.parent_id = t.id AND c.status = 'open')",
    `NOT ${heldBackSql("t")}`,
    ...filter.conditions,
  ];
  return db
    .prepare(
      `SELECT t.id, t.title, t.category_id AS categoryId, t.goal_id AS goalId,
              t.impact, t.effort_minutes AS effortMinutes, t.due_date AS dueDate,
              t.created_at AS createdAt, t.recur_every_days AS recurEveryDays,
              t.last_drawn_at AS lastDrawnAt, t.deferred_until AS deferredUntil,
              (SELECT MAX(completed_at) FROM completions WHERE task_id = t.id) AS lastCompletedAt
       FROM tasks t WHERE ${conditions.join(" AND ")}`,
    )
    .all(maxEffort, now.toISOString(), ...filter.params) as PoolCandidate[];
}

/**
 * Side-effect-free deck snapshot for GET /api/draw/pool (backs the MCP
 * draw://deck resource): the same candidates and weights a draw would use,
 * but no `last_drawn_at` stamp, no persisted current draw, no achievement
 * check.
 */
export function drawPool(filters: DrawFilters): {
  poolSize: number;
  maxDrawEffort: number;
  candidates: Array<Record<string, unknown>>;
} {
  const maxEffort = getSetting("max_draw_effort", 30);
  const cooldown = getSetting("draw_cooldown_minutes", 60);
  const now = new Date();
  const candidates = queryCandidates(filters, maxEffort, now);
  const weights = candidates.map((c) => weight(c, now, cooldown, candidates.length));
  const total = weights.reduce((a, b) => a + b, 0);
  return {
    poolSize: candidates.length,
    maxDrawEffort: maxEffort,
    candidates: candidates.map((c, i) => ({
      id: c.id,
      title: c.title,
      categoryId: c.categoryId,
      goalId: c.goalId,
      impact: c.impact,
      effortMinutes: c.effortMinutes,
      dueDate: c.dueDate,
      weight: weights[i],
      probability: total > 0 ? weights[i] / total : 0,
    })),
  };
}

export function drawTask(filters: DrawFilters): DrawResult {
  const maxEffort = getSetting("max_draw_effort", 30);
  const cooldown = getSetting("draw_cooldown_minutes", 60);
  const now = new Date();

  const candidates = queryCandidates(filters, maxEffort, now);

  if (candidates.length === 0) {
    // The draw replaced whatever card was showing — even an empty draw, so a
    // reload doesn't resurrect a card the user already saw disappear.
    clearCurrentDraw();
    // Distinguish "nothing at all" from "only oversized/unestimated tasks".
    // Snoozed/blocked cards are not "too big" — they come back on their own
    // (or on wake), so they must not trigger the break-something-down hint.
    // Held-back sequential siblings are excluded the same way: they surface
    // by completing the step in front, never by being broken down (#23).
    const filter = filterConditions(filters);
    const anyOpen = db
      .prepare(
        `SELECT COUNT(*) AS n FROM tasks t
         WHERE t.status = 'open'
           AND ${SNOOZE_CONDITION}
           AND NOT EXISTS(SELECT 1 FROM tasks c WHERE c.parent_id = t.id AND c.status = 'open')
           AND NOT ${heldBackSql("t")}
           ${filter.conditions.map((c) => `AND ${c}`).join(" ")}`,
      )
      .get(now.toISOString(), ...filter.params) as { n: number };
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
              t.last_drawn_at AS lastDrawnAt, t.deferred_until AS deferredUntil, t.blocked,
              t.subtask_order_mode AS subtaskOrderMode,
              0 AS hasOpenChildren, 0 AS heldBack
       FROM tasks t WHERE t.id = ?`,
    )
    .get(chosen.id) as Record<string, unknown>;

  return {
    task: withBooleanBlocked(task),
    poolSize: candidates.length,
    probability: weights[picked] / total,
  };
}

/** SQLite stores booleans as 0/1 — task JSON payloads expose a real boolean. */
export function withBooleanBlocked(task: Record<string, unknown>): Record<string, unknown> {
  task.blocked = Boolean(task.blocked);
  return task;
}

// ---------------------------------------------------------------------------
// Current draw — the drawn card persisted across reloads (ADR-13), restored
// by the DrawPage the same way the TimerBar restores the running timer.

export interface RestorableTask {
  status: string;
  effortMinutes: number | null;
  hasOpenChildren: number;
  blocked: number | boolean;
  deferredUntil: string | null;
  heldBack: number | boolean;
}

/**
 * Restore-validation for a persisted draw. Mirrors the client's
 * `classifyTask` and the candidate WHERE clause above: only an open leaf
 * task with an estimate within the draw limit, neither blocked nor snoozed
 * into the future nor held back behind a sequential sibling (#23), is still
 * in the deck. Pinned against the same vectors as the client
 * (`shared/drawableVectors.ts`) so the two cannot drift.
 */
export function isRestorable(task: RestorableTask, maxEffort: number, now: Date): boolean {
  return (
    task.status === "open" &&
    !task.hasOpenChildren &&
    !task.blocked &&
    (task.deferredUntil == null || new Date(task.deferredUntil) <= now) &&
    !task.heldBack &&
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
 * Clear the persisted draw when its task row no longer exists — covers the
 * drawn subtask cascade-deleted with its parent as well as a direct delete.
 * Deliberately eager, unlike the sideways-stale cases handled lazily below:
 * `tasks.id` has no AUTOINCREMENT, so SQLite can re-bind a freed id to the
 * next captured task before any restore validation runs, and the never-drawn
 * newcomer would be restored — and paid the drawn bonus — under the old id.
 */
export function clearDanglingDraw() {
  const id = getCurrentDrawTaskId();
  if (id != null && !db.prepare("SELECT 1 FROM tasks WHERE id = ?").get(id)) {
    deleteSetting(CURRENT_DRAW_SETTING);
  }
}

/**
 * The persisted current draw, for restore after a reload. A pointer that went
 * stale sideways (task completed elsewhere, edited out of the deck, turned
 * into a container) is cleared lazily here and null is returned.
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
              t.last_drawn_at AS lastDrawnAt, t.deferred_until AS deferredUntil, t.blocked,
              t.subtask_order_mode AS subtaskOrderMode,
              EXISTS(SELECT 1 FROM tasks c WHERE c.parent_id = t.id AND c.status = 'open') AS hasOpenChildren,
              ${heldBackSql("t")} AS heldBack
       FROM tasks t WHERE t.id = ?`,
    )
    .get(id) as (Record<string, unknown> & RestorableTask) | undefined;

  const maxEffort = getSetting("max_draw_effort", 30);
  if (!task || !isRestorable(task, maxEffort, new Date())) {
    clearCurrentDraw();
    return null;
  }
  return { task: withBooleanBlocked(task) };
}
