import {
  CURRENT_DRAW_SETTING,
  db,
  deleteSetting,
  getSetting,
  getSettingString,
  setSetting,
  WARMUP_DRAW_SETTING,
  WARMUP_LAST_DEALT_SETTING,
} from "../db.js";
import { isAwaitingNextOccurrence } from "./recurrence.js";

export interface Candidate {
  id: number;
  parentId: number | null;
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
  /** Availability window (#33, ADR-20) — window_days as raw JSON text. */
  windowDays: string | null;
  windowStart: string | null;
  windowEnd: string | null;
}

export interface DrawFilters {
  categoryId?: number;
  goalId?: number;
}

export interface DrawResult {
  task: Record<string, unknown> | null;
  reason?:
    | "no_ready_tasks"
    | "all_too_big"
    | "all_outside_window"
    | "all_awaiting_next_occurrence"
    | "cooling_down"
    | "warmup_unavailable";
  poolSize?: number;
  probability?: number;
  /** Present when the deal was a warm-up (#57, ADR-30). */
  warmup?: WarmupMarker;
  /** Present with reason "warmup_unavailable": when the next deal opens. */
  nextWarmupAt?: string;
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

/**
 * The date staleness counts from: creation, or the last completion for
 * recurring tasks, bumped forward by a later snooze wake — snooze time is not
 * "lying around": deferred_until is retained after expiry (ADR-17), so a
 * woken card's staleness counts from its wake time. Shared by stalenessFactor
 * and the warm-up tie-break (#57) so "most stale" can never mean two things.
 */
export function stalenessAnchor(candidate: Candidate): Date {
  const base =
    candidate.recurEveryDays != null && candidate.lastCompletedAt
      ? new Date(candidate.lastCompletedAt)
      : new Date(candidate.createdAt);
  const wake = candidate.deferredUntil ? new Date(candidate.deferredUntil) : null;
  return wake && wake > base ? wake : base;
}

export function stalenessFactor(candidate: Candidate, now: Date): number {
  const days = Math.max(0, (now.getTime() - stalenessAnchor(candidate).getTime()) / DAY_MS);
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

/**
 * Sibling damping (#30, ADR-25): a k-sibling breakdown flooding the pool
 * competes like ~√k cards instead of k. Simulation (server/scripts/
 * sim-issue30.ts) showed a 40-leaf #29 import taking 58% of the probability
 * mass on day 0 against a 12-task organic deck — rising to 63% within a week
 * because fresh leaves gain staleness while old organic tasks sit at the ×2
 * cap. Damped, the same import holds ~18% and the share decays smoothly as
 * leaves complete. k = 1 (parentless tasks, single children) is exactly 1.
 */
export function siblingDamping(poolSiblingCount: number): number {
  return 1 / Math.sqrt(Math.max(poolSiblingCount, 1));
}

/**
 * Weights for a candidate pool — the single home of the damping rule so
 * drawTask() and drawPool() cannot drift. k counts siblings PRESENT IN THE
 * POOL, not open siblings: a held-back sequential queue (#23), snoozed or
 * out-of-window siblings do not flood the deck, so they must not dampen the
 * one card that represents them (a sequential 40-leaf import competes as the
 * single fairly-weighted card it shows).
 */
export function poolWeights(candidates: Candidate[], now: Date, cooldownMinutes: number): number[] {
  const siblingsInPool = new Map<number, number>();
  for (const c of candidates) {
    if (c.parentId != null) {
      siblingsInPool.set(c.parentId, (siblingsInPool.get(c.parentId) ?? 0) + 1);
    }
  }
  return candidates.map(
    (c) =>
      weight(c, now, cooldownMinutes, candidates.length) *
      siblingDamping(c.parentId == null ? 1 : (siblingsInPool.get(c.parentId) as number)),
  );
}

// Snooze/block (ADR-17): kept as a derived predicate alongside the rest —
// an expired deferred_until re-enters the pool with no write.
const SNOOZE_CONDITION = "t.blocked = 0 AND (t.deferred_until IS NULL OR t.deferred_until <= ?)";

// A drawable card is a LEAF: zero non-archived children (#111, ADR-32). The
// pre-#111 form excluded only OPEN children, so a parent whose last subtask
// closed re-entered the pool on its own stored estimate — under the parent
// lifecycle the subtasks own the estimate for as long as any of them exists.
const LEAF_CONDITION =
  "NOT EXISTS(SELECT 1 FROM tasks c WHERE c.parent_id = t.id AND c.status != 'archived')";

/**
 * Derived hold-back predicate (#23, ADR-18): the task sits behind an earlier
 * open sibling under a 'sequential' parent. Sibling order is (sort_order, id)
 * since #157 (ADR-43) — the stored, drag-reorderable position the Tasks page
 * renders in; the id tie-break keeps siblings that share a sort_order (a
 * pre-#157 backfill gives every row a distinct one, but a mid-renormalize read
 * could momentarily tie) deterministic. Like snoozing, this is never a stored
 * flag: completing the earlier sibling — or reordering this one ahead of it —
 * frees the next one with no write to the freed row.
 */
export function heldBackSql(alias: string): string {
  return `EXISTS(
    SELECT 1 FROM tasks p JOIN tasks s ON s.parent_id = p.id
    WHERE p.id = ${alias}.parent_id AND p.subtask_order_mode = 'sequential'
      AND s.status = 'open'
      AND (s.sort_order < ${alias}.sort_order OR (s.sort_order = ${alias}.sort_order AND s.id < ${alias}.id))
  )`;
}

/**
 * Availability-window predicate (#33, ADR-20): true when the task has no
 * window, or `now` falls on one of its weekdays inside [start, end) — start
 * inclusive, end exclusive, "24:00" meaning end-of-day. Deliberately LOCAL
 * wall clock (`getDay`/`getHours`, never `getUTC*`): "Mon–Fri 08:00–12:00"
 * means the user's own clock, consistent with due-date urgency above. This is
 * also why the check runs in TypeScript and not in the candidate SQL —
 * SQLite's strftime('%w')/time('now') evaluate in UTC. Mirrored by the client
 * (drawable.ts) and pinned by shared/drawableVectors.ts WINDOW_VECTORS.
 */
export function isWithinWindow(
  days: number[] | null | undefined,
  start: string | null | undefined,
  end: string | null | undefined,
  now: Date,
): boolean {
  if (days == null || start == null || end == null) return true;
  if (!days.includes(now.getDay())) return false;
  const toMinutes = (hhmm: string) => {
    const [h, m] = hhmm.split(":").map(Number);
    return h * 60 + m; // "24:00" → 1440
  };
  const minutes = now.getHours() * 60 + now.getMinutes();
  return minutes >= toMinutes(start) && minutes < toMinutes(end);
}

/**
 * window_days column (validated JSON) → number[] | null. Writes are validated,
 * so corrupt JSON only exists in a hand-edited DB — but this runs on every
 * task payload, so contain it as null (= unwindowed, the pool-safe reading)
 * rather than letting one bad row take down whole endpoints.
 */
export function parseWindowDays(raw: unknown): number[] | null {
  if (typeof raw !== "string") return null;
  try {
    return JSON.parse(raw) as number[];
  } catch {
    return null;
  }
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
 * drawPool() below so the two can never drift. Two exclusions are applied
 * here as TypeScript post-filters over the SQL rows: the availability window
 * (#33), whose local wall-clock semantics SQLite's UTC time functions cannot
 * express, and the recurrence sleep (#205), whose exclusion COUNT the
 * empty-pool dispatch needs. Both callers share one predicate by
 * construction. `windowExcluded` / `occurrenceExcluded` count the rows each
 * filter removed; drawTask's empty-pool dispatch turns them into
 * `all_outside_window` / `all_awaiting_next_occurrence`.
 */
export function queryCandidates(
  filters: DrawFilters,
  maxEffort: number,
  now: Date,
): { candidates: PoolCandidate[]; windowExcluded: number; occurrenceExcluded: number } {
  const filter = filterConditions(filters);
  const conditions = [
    "t.status = 'open'",
    "t.effort_minutes IS NOT NULL",
    "t.effort_minutes <= ?",
    SNOOZE_CONDITION,
    // Any NON-ARCHIVED child keeps a parent out of the deck (#111, ADR-32):
    // while a breakdown exists — even all-done — the parent's own stored
    // estimate is display/draw-inert; only archived-out children (split
    // leftovers) or children moved away revive it as a drawable leaf.
    LEAF_CONDITION,
    `NOT ${heldBackSql("t")}`,
    ...filter.conditions,
  ];
  const rows = db
    .prepare(
      `SELECT t.id, t.title, t.parent_id AS parentId, t.category_id AS categoryId, t.goal_id AS goalId,
              t.impact, t.effort_minutes AS effortMinutes, t.due_date AS dueDate,
              t.created_at AS createdAt, t.recur_every_days AS recurEveryDays,
              t.last_drawn_at AS lastDrawnAt, t.deferred_until AS deferredUntil,
              t.window_days AS windowDays, t.window_start AS windowStart, t.window_end AS windowEnd,
              (SELECT MAX(completed_at) FROM completions WHERE task_id = t.id) AS lastCompletedAt
       FROM tasks t WHERE ${conditions.join(" AND ")}`,
    )
    .all(maxEffort, now.toISOString(), ...filter.params) as PoolCandidate[];
  const inWindow = rows.filter((r) =>
    isWithinWindow(parseWindowDays(r.windowDays), r.windowStart, r.windowEnd, now),
  );
  const candidates = inWindow.filter(
    (r) => !isAwaitingNextOccurrence(r.recurEveryDays, r.dueDate, now),
  );
  return {
    candidates,
    windowExcluded: rows.length - inWindow.length,
    occurrenceExcluded: inWindow.length - candidates.length,
  };
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
  const { candidates } = queryCandidates(filters, maxEffort, now);
  const weights = poolWeights(candidates, now, cooldown);
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

/**
 * Why an otherwise-eligible pool came up empty — shared by drawTask and
 * warmupDraw so an empty warm-up reports the same honest reasons. Out-of-
 * window candidates take precedence over the anyOpen dispatch (#33): if the
 * SQL query produced candidates and only the window filter emptied the pool,
 * the honest answer is "scheduled for later" — these cards return on their
 * own, so the break-something-down hint would mislead. Recurring cards
 * sleeping until their next occurrence (#205) are the same shape and get the
 * same treatment, one reason further down. A task that is oversized AND
 * out-of-window (or oversized AND sleeping) never reaches either filter (SQL
 * already dropped it) and still counts toward all_too_big: it will not
 * become drawable by waiting. Beyond that, "nothing at all" is distinguished
 * from "only oversized/unestimated tasks": snoozed/blocked cards are not
 * "too big" — they come back on their own (or on wake) — and held-back
 * sequential siblings surface by completing the step in front, never by
 * being broken down (#23), so neither triggers the break-something-down
 * hint.
 */
export function emptyPoolReason(
  filters: DrawFilters,
  windowExcluded: number,
  occurrenceExcluded: number,
  now: Date,
): "no_ready_tasks" | "all_too_big" | "all_outside_window" | "all_awaiting_next_occurrence" {
  if (windowExcluded > 0) return "all_outside_window";
  if (occurrenceExcluded > 0) return "all_awaiting_next_occurrence";
  const filter = filterConditions(filters);
  const anyOpen = db
    .prepare(
      `SELECT COUNT(*) AS n FROM tasks t
       WHERE t.status = 'open'
         AND ${SNOOZE_CONDITION}
         AND ${LEAF_CONDITION}
         AND NOT ${heldBackSql("t")}
         ${filter.conditions.map((c) => `AND ${c}`).join(" ")}`,
    )
    .get(now.toISOString(), ...filter.params) as { n: number };
  return anyOpen.n > 0 ? "all_too_big" : "no_ready_tasks";
}

/**
 * Minutes tracked on the task so far, derived at query time from
 * time_entries (ADR-2 spirit — never a counter). Introduced as the TCG
 * frame's DEF stat (#115); the UI no longer renders it since #123 dropped
 * the frame, but the field stays on the draw payloads for API/MCP consumers
 * — dropping it would break them for no gain. CLOSED entries only: a
 * consumer that wants a live total adds the running entry's elapsed time
 * itself instead of refetching this payload every minute (useStopTimer
 * still folds a just-closed entry into the cached copy). Floored, not
 * rounded — CAST truncates toward zero, which equals floor for these
 * non-negative durations — so the total agrees with any consumer's own
 * floored live math and can never fold one higher the moment a timer stops
 * (live 10 + 1.9 showed 11; ROUND(11.9) folded to 12).
 */
const TRACKED_MINUTES_SQL = `(SELECT CAST(COALESCE(SUM(
         (julianday(e.ended_at) - julianday(e.started_at)) * 1440.0), 0) AS INTEGER)
       FROM time_entries e WHERE e.task_id = t.id AND e.ended_at IS NOT NULL)`;

/** Full payload row for a freshly dealt card — a pool candidate is an open
 *  leaf by construction (zero non-archived children, #111), so
 *  hasOpenChildren/hasNonArchivedChildren/heldBack are constant 0. */
export function dealtTaskRow(id: number): Record<string, unknown> {
  return db
    .prepare(
      `SELECT t.id, t.title, t.description,
              t.category_id AS categoryId, t.goal_id AS goalId, t.parent_id AS parentId,
              t.impact, t.effort_minutes AS effortMinutes, t.due_date AS dueDate,
              t.recur_every_days AS recurEveryDays, t.status,
              t.created_at AS createdAt, t.completed_at AS completedAt,
              t.last_drawn_at AS lastDrawnAt, t.deferred_until AS deferredUntil, t.blocked,
              t.subtask_order_mode AS subtaskOrderMode,
              t.window_days AS windowDays, t.window_start AS windowStart, t.window_end AS windowEnd,
              0 AS hasOpenChildren, 0 AS hasNonArchivedChildren, 0 AS heldBack,
              ${TRACKED_MINUTES_SQL} AS trackedMinutes
       FROM tasks t WHERE t.id = ?`,
    )
    .get(id) as Record<string, unknown>;
}

export function drawTask(filters: DrawFilters): DrawResult {
  const maxEffort = getSetting("max_draw_effort", 30);
  const cooldown = getSetting("draw_cooldown_minutes", 60);
  const now = new Date();

  const { candidates, windowExcluded, occurrenceExcluded } = queryCandidates(
    filters,
    maxEffort,
    now,
  );

  if (candidates.length === 0) {
    // The draw replaced whatever card was showing — even an empty draw, so a
    // reload doesn't resurrect a card the user already saw disappear.
    clearCurrentDraw();
    return { task: null, reason: emptyPoolReason(filters, windowExcluded, occurrenceExcluded, now) };
  }

  const weights = poolWeights(candidates, now, cooldown);
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
  // Log the deal to the append-only draws table (#156, ADR-42): a real,
  // gambled draw (was_warmup 0) — the source of truth for the draws
  // achievement chain, which counts non-warmup rows only.
  db.prepare("INSERT INTO draws (task_id, drawn_at, was_warmup) VALUES (?, ?, 0)").run(
    chosen.id,
    now.toISOString(),
  );
  // Persist the draw so a page reload restores the card (ADR-13) — a new
  // draw simply overwrites the previous one. A regular draw is never a
  // warm-up, so a leftover marker is dropped with the pointer it described.
  setSetting(CURRENT_DRAW_SETTING, String(chosen.id));
  deleteSetting(WARMUP_DRAW_SETTING);

  return {
    task: toTaskPayload(dealtTaskRow(chosen.id)),
    poolSize: candidates.length,
    probability: weights[picked] / total,
  };
}

/**
 * Row → JSON payload: SQLite stores booleans as 0/1 (blocked becomes a real
 * boolean) and the availability window's weekdays as JSON text (windowDays
 * becomes number[] | null).
 */
export function toTaskPayload(task: Record<string, unknown>): Record<string, unknown> {
  task.blocked = Boolean(task.blocked);
  task.windowDays = parseWindowDays(task.windowDays);
  return task;
}

// ---------------------------------------------------------------------------
// Current draw — the drawn card persisted across reloads (ADR-13), restored
// by the DrawPage the same way the TimerBar restores the running timer.

export interface RestorableTask {
  status: string;
  effortMinutes: number | null;
  hasOpenChildren: number;
  /**
   * Any non-archived child — done ones included — keeps the card out of the
   * deck (#111, ADR-32). Optional: payload shapes that predate the field
   * (or the dealt-card constant) simply skip the check.
   */
  hasNonArchivedChildren?: number | boolean;
  blocked: number | boolean;
  deferredUntil: string | null;
  heldBack: number | boolean;
  /**
   * Recurrence schedule (#205): `due_date` is the next occurrence, and a
   * recurring card sleeps until it arrives. Optional, like the fields above:
   * a payload shape without them simply skips the check.
   */
  recurEveryDays?: number | null;
  dueDate?: string | null;
  /** Parsed window (#33) — run rows through toTaskPayload() before validating. */
  windowDays: number[] | null;
  windowStart: string | null;
  windowEnd: string | null;
}

/**
 * Restore-validation for a persisted draw. Mirrors the client's
 * `classifyTask` and the candidate WHERE clause above: only an open leaf
 * task with an estimate within the draw limit, neither blocked nor snoozed
 * into the future nor held back behind a sequential sibling (#23) nor
 * outside its availability window (#33) nor sleeping until its next
 * occurrence (#205), is still in the deck. Like
 * snooze wear-off, the window check makes the stale pointer clear lazily —
 * a card whose window closed (or that was edited out of its window) is not
 * resurrected by a reload. Pinned against the same vectors as the client
 * (`shared/drawableVectors.ts`) so the two cannot drift.
 */
export function isRestorable(task: RestorableTask, maxEffort: number, now: Date): boolean {
  return (
    task.status === "open" &&
    !task.hasOpenChildren &&
    !task.hasNonArchivedChildren &&
    !task.blocked &&
    (task.deferredUntil == null || new Date(task.deferredUntil) <= now) &&
    !task.heldBack &&
    isWithinWindow(task.windowDays, task.windowStart, task.windowEnd, now) &&
    !isAwaitingNextOccurrence(task.recurEveryDays, task.dueDate, now) &&
    task.effortMinutes != null &&
    task.effortMinutes <= maxEffort
  );
}

export function getCurrentDrawTaskId(): number | null {
  const raw = getSettingString(CURRENT_DRAW_SETTING);
  return raw == null ? null : Number(raw);
}

/**
 * Clear the persisted draw — unconditionally, or only if it matches taskId.
 * The warm-up marker (#57) describes the current draw and nothing else, so it
 * dies with the pointer on every path — complete, snooze/block, delete,
 * redraw, lazy restore invalidation — and can never point at a card that is
 * no longer the current draw.
 */
export function clearCurrentDraw(taskId?: number) {
  if (taskId === undefined || getCurrentDrawTaskId() === taskId) {
    deleteSetting(CURRENT_DRAW_SETTING);
    deleteSetting(WARMUP_DRAW_SETTING);
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
    deleteSetting(WARMUP_DRAW_SETTING);
  }
}

/**
 * A task row carrying the DERIVED deck-state columns isRestorable needs —
 * unlike dealtTaskRow's constants, these are computed, because a pointer into
 * the deck can go stale sideways (the card was broken down, or reparented
 * behind a sequential sibling). The one home of the restore-validation row
 * shape, so restore surfaces cannot drift into disagreeing about what is
 * still in the deck. Undefined when the row is gone.
 */
export function taskWithDeckState(id: number): Record<string, unknown> | undefined {
  return db
    .prepare(
      `SELECT t.id, t.title, t.description,
              t.category_id AS categoryId, t.goal_id AS goalId, t.parent_id AS parentId,
              t.impact, t.effort_minutes AS effortMinutes, t.due_date AS dueDate,
              t.recur_every_days AS recurEveryDays, t.status,
              t.created_at AS createdAt, t.completed_at AS completedAt,
              t.last_drawn_at AS lastDrawnAt, t.deferred_until AS deferredUntil, t.blocked,
              t.subtask_order_mode AS subtaskOrderMode,
              t.window_days AS windowDays, t.window_start AS windowStart, t.window_end AS windowEnd,
              EXISTS(SELECT 1 FROM tasks c WHERE c.parent_id = t.id AND c.status = 'open') AS hasOpenChildren,
              EXISTS(SELECT 1 FROM tasks c WHERE c.parent_id = t.id AND c.status != 'archived') AS hasNonArchivedChildren,
              ${heldBackSql("t")} AS heldBack,
              ${TRACKED_MINUTES_SQL} AS trackedMinutes
       FROM tasks t WHERE t.id = ?`,
    )
    .get(id) as Record<string, unknown> | undefined;
}

/**
 * The persisted current draw, for restore after a reload. A pointer that went
 * stale sideways (task completed elsewhere, edited out of the deck, turned
 * into a container) is cleared lazily here and null is returned. When the
 * restored card was warm-up dealt (#57) the marker rides along, so the badge
 * and bonus-window hint survive a reload exactly like the card (ADR-13).
 */
export function currentDraw(): { task: Record<string, unknown>; warmup?: WarmupMarker } | null {
  const id = getCurrentDrawTaskId();
  if (id == null) return null;

  const task = taskWithDeckState(id);
  const maxEffort = getSetting("max_draw_effort", 30);
  const payload = task && toTaskPayload(task); // parses windowDays for isRestorable
  if (!payload || !isRestorable(payload as unknown as RestorableTask, maxEffort, new Date())) {
    clearCurrentDraw();
    return null;
  }
  const marker = getWarmupMarker();
  return marker && marker.taskId === id ? { task: payload, warmup: marker } : { task: payload };
}

// ---------------------------------------------------------------------------
// Warm-up draw (#57, ADR-30) — the "I can't start" escape hatch: one
// deterministic deal of the objectively smallest eligible card, offered on
// the IDLE deck only. NOT a re-roll (#88): the route rejects a deal while a
// valid current draw exists, and the dealt card is the same commitment as a
// drawn one — persisted as the current draw, resolvable only by complete,
// snooze/block, or delete.

export interface WarmupMarker {
  taskId: number;
  dealtAt: string;
  /** Bonus window in minutes from dealtAt: max(effort at deal time, 15). */
  windowMinutes: number;
}

function readJsonSetting<T>(key: string): T | null {
  const raw = getSettingString(key);
  if (raw == null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    // hand-edited DB — treat as absent rather than breaking every draw read
    return null;
  }
}

/** The warm-up marker on the CURRENT draw, or null. */
export function getWarmupMarker(): WarmupMarker | null {
  return readJsonSetting<WarmupMarker>(WARMUP_DRAW_SETTING);
}

/** The last warm-up deal ever — rate-limit state, never cleared. */
export function getLastWarmupDeal(): { taskId: number; dealtAt: string } | null {
  return readJsonSetting<{ taskId: number; dealtAt: string }>(WARMUP_LAST_DEALT_SETTING);
}

/** One warm-up per `warmup_every_hours` (public setting, default 8). */
export function warmupAvailability(now: Date): { available: boolean; nextWarmupAt: string | null } {
  const everyHours = getSetting("warmup_every_hours", 8);
  const last = getLastWarmupDeal();
  if (!last) return { available: true, nextWarmupAt: null };
  const nextAt = new Date(new Date(last.dealtAt).getTime() + everyHours * 3_600_000);
  return nextAt <= now
    ? { available: true, nextWarmupAt: null }
    : { available: false, nextWarmupAt: nextAt.toISOString() };
}

/**
 * The deterministic warm-up pick: minimum effort_minutes, tie-broken by most
 * stale (the stalenessAnchor shared with the weight formula — including the
 * recurring last-completion base and the snooze-wake bump), final tie-break
 * lowest id. Impact, urgency, and the staleness WEIGHT are deliberately
 * bypassed — the whole point is the objectively smallest card, not a clever
 * one. The cooldown applies as EXCLUSION, not the regular draw's ×0.15
 * dampening: a dampener is meaningless for a deterministic pick, and
 * exclusion prevents deal → discard → deal-the-same-card churn. Returns null
 * when the exclusion emptied the pool ("cooling down").
 */
export function pickWarmup<T extends Candidate>(
  candidates: T[],
  now: Date,
  cooldownMinutes: number,
): T | null {
  let best: T | null = null;
  let bestAnchor = 0;
  for (const c of candidates) {
    if (
      c.lastDrawnAt != null &&
      (now.getTime() - new Date(c.lastDrawnAt).getTime()) / 60_000 < cooldownMinutes
    ) {
      continue;
    }
    const anchor = stalenessAnchor(c).getTime();
    if (
      best == null ||
      c.effortMinutes < best.effortMinutes ||
      (c.effortMinutes === best.effortMinutes &&
        (anchor < bestAnchor || (anchor === bestAnchor && c.id < best.id)))
    ) {
      best = c;
      bestAnchor = anchor;
    }
  }
  return best;
}

/**
 * Deal the warm-up card. Same eligibility pool as drawTask (queryCandidates —
 * the two can never drift), same deal side effects (last_drawn_at stamp,
 * persisted current draw), plus the warm-up marker and the irrevocable
 * allowance consumption. Precondition (enforced by the route with the same
 * lazy validation GET /api/draw/current uses): no valid current draw exists —
 * the warm-up is only ever offered on the idle deck (#88).
 */
export function warmupDraw(filters: DrawFilters): DrawResult {
  const now = new Date();
  const availability = warmupAvailability(now);
  if (!availability.available) {
    return { task: null, reason: "warmup_unavailable", nextWarmupAt: availability.nextWarmupAt! };
  }

  const maxEffort = getSetting("max_draw_effort", 30);
  const cooldown = getSetting("draw_cooldown_minutes", 60);
  const { candidates, windowExcluded, occurrenceExcluded } = queryCandidates(
    filters,
    maxEffort,
    now,
  );
  if (candidates.length === 0) {
    // Nothing was dealt: the allowance is NOT consumed, and there is no
    // current draw to clear (the route's idle guard already ensured that).
    return { task: null, reason: emptyPoolReason(filters, windowExcluded, occurrenceExcluded, now) };
  }

  const chosen = pickWarmup(candidates, now, cooldown);
  if (!chosen) return { task: null, reason: "cooling_down" };

  db.prepare("UPDATE tasks SET last_drawn_at = ? WHERE id = ?").run(now.toISOString(), chosen.id);
  // Log the deal (#156, ADR-42) with was_warmup 1: a warm-up card was handed
  // out, not gambled (ADR-30), so it lands in the draws log but is excluded
  // from the draws achievement chain.
  db.prepare("INSERT INTO draws (task_id, drawn_at, was_warmup) VALUES (?, ?, 1)").run(
    chosen.id,
    now.toISOString(),
  );
  setSetting(CURRENT_DRAW_SETTING, String(chosen.id));
  const marker: WarmupMarker = {
    taskId: chosen.id,
    dealtAt: now.toISOString(),
    // Small cards get a floor: a 2-minute card with a 2-minute window would
    // punish reading the description.
    windowMinutes: Math.max(chosen.effortMinutes, 15),
  };
  setSetting(WARMUP_DRAW_SETTING, JSON.stringify(marker));
  // Consumed at DEAL time, never refunded — snoozing or deleting the dealt
  // card must not open a second deal, or the warm-up becomes a fishing rod.
  setSetting(
    WARMUP_LAST_DEALT_SETTING,
    JSON.stringify({ taskId: chosen.id, dealtAt: now.toISOString() }),
  );

  // No poolSize: a deal has no odds (the client's odds line keys off
  // `probability`), and candidates.length would overcount anyway — pickWarmup
  // skips cooldown-excluded cards the count would still include.
  return {
    task: toTaskPayload(dealtTaskRow(chosen.id)),
    warmup: marker,
  };
}
