import { db } from "../db.js";
import { undoLatestCompletion } from "./gamificationService.js";

/**
 * Task-creation cores, extracted verbatim from routes/tasks.ts (#31): the
 * assistant's apply step must run the SAME validation the routes run — one
 * atomic transaction over many creates — and duplicating ~200 lines of guard
 * logic would fork every invariant (ADR-4 impact gate, ADR-16 one-level,
 * ADR-23 recurring × sequential, #111 lifecycle hooks). So POST /api/tasks and
 * POST /api/tasks/:id/subtasks now call these functions, and so does
 * agentService.applyChangeset — inside one outer db.transaction (better-sqlite3
 * nests via savepoints), where any error thrown here rolls back the whole
 * changeset.
 *
 * Every function returns `{ status, error }` instead of writing to a Response,
 * so the route stays the HTTP boundary and the core stays callable in a
 * transaction. Behavior (check order, messages, side effects) is unchanged —
 * the existing tasks/validation/parent-lifecycle suites pin it.
 */

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export const IMPACT_REQUIRES_GOAL =
  "impact is only meaningful for goal-linked tasks (ADR-4): set a goalId together with " +
  "impact, or omit it — goal-less tasks keep the neutral default 3";

// Breakdowns are one level deep (ADR-16, #35). Nesting is banned, not merely
// unsupported: every list renders roots plus one child level (a grandchild
// would be draw-eligible yet invisible everywhere), the goal/category
// cascades reach direct children only, and the derived remainingEffortMinutes
// rollup sums direct open children — a middle task's stored estimate inside
// its parent's sum would be a lie. Enforced on BOTH creation paths (the batch
// endpoint and POST / with parentId), so the invariant holds no matter which
// one an API/MCP caller picks.
export const NESTED_BREAKDOWN_ERROR =
  "breakdowns are one level deep (ADR-16): this task is itself a subtask and cannot be " +
  "broken down further — add the steps as additional subtasks of its root parent instead";

// Archived parents take no children (#104 item 1). Every other path that puts
// a child under a done root REOPENS the root (#111, ADR-32) — the root plainly
// is not finished any more. The archived twin of that move must NOT auto-revive
// its root: archiving means "deliberately off the board" (ADR-21), and #122
// already settled that the system never lifts that state implicitly — an
// archived row cannot even be completed directly, it must be un-archived first.
// Leaving the adoption legal instead was the actual bug: an OPEN child under an
// archived root is draw-eligible (the pool filters the CHILD's status, ADR-2)
// while the Tasks page hides it with its root (status != 'archived') — a card
// that can be dealt but never found. So the honest repair is the transition the
// router already supports: un-archive the root (status: 'open'), then adopt.
// Rejected regardless of the mover's status, matching ARCHIVED_TO_DONE_ERROR's
// uniform shape: one rule per direction, no status matrix to remember.
export const ARCHIVED_PARENT_ERROR =
  "an archived task cannot take subtasks (ADR-21): un-archive it first (status: 'open'), then " +
  "add or move the subtask — an open child under an archived root would be drawable but hidden " +
  "from the Tasks page with its root";

// Recurring × sequential ban (#66, ADR-23): a recurring step never closes —
// completing it advances its due date instead (ADR-6) — so under a
// 'sequential' parent it would hold every later sibling back forever
// (heldBackSql only frees a step when the one in front stops being open).
// The combination is rejected on every path that could CREATE it: subtask
// creation, recurrence edits, and mode flips. Pre-existing rows stay
// operable — a no-op resend of the stored value passes, mirroring the ADR-4
// impact gate.
export const RECURRING_SEQUENTIAL_ERROR =
  "recurring subtasks cannot be part of a sequential breakdown (ADR-23): a recurring step " +
  "never closes — completing it advances its due date (ADR-6) — so it would hold every " +
  "later step back forever. Drop the recurrence, or keep the parent's subtasks parallel";

// Subtasks follow their parent's goal and category. The batch endpoint
// inherits both by construction; since #84 the single-create path does too —
// before, POST with parentId ignored the parent's goal entirely, so a child
// could carry its OWN goal under a goal-less parent (PR #82). In that
// divergent state the parent edit form's no-op goalId resend would cascade
// goal_id over the child WITHOUT the ADR-4 unlink reset (`unlinking` is
// false) — silently wiping the child's link while its non-neutral rating
// survived: an undocumented third grandfathering path. Divergence is gated
// explicitly (a conflicting value is rejected, not silently overridden);
// omitted values inherit.
export const SUBTASK_GOAL_ERROR =
  "subtasks follow their parent's goal: omit goalId when creating with a parentId (it is " +
  "inherited), or pass the parent's own goalId";
export const SUBTASK_CATEGORY_ERROR =
  "subtasks inherit their parent's category: omit categoryId when creating with a parentId, " +
  "or pass the parent's own categoryId (a subtask's category stays editable afterwards)";

/**
 * Request-shape validation (#84): malformed field types used to surface as
 * raw 500s — better-sqlite3 binding TypeErrors or CHECK-constraint
 * violations — instead of honest 400s. Shared by POST /, POST /:id/subtasks
 * (per row) and PATCH /:id; only keys present in the body are judged, so
 * PATCH's sparse bodies pass untouched fields through.
 */
export function fieldShapeError(body: Record<string, unknown>): string | null {
  if ("title" in body && (typeof body.title !== "string" || !body.title.trim())) {
    return "title must be a non-empty string";
  }
  if (body.description != null && typeof body.description !== "string") {
    return "description must be a string";
  }
  if (
    body.effortMinutes != null &&
    (!Number.isInteger(body.effortMinutes) || (body.effortMinutes as number) < 1)
  ) {
    return "effortMinutes must be a positive integer";
  }
  if (body.dueDate != null && typeof body.dueDate !== "string") {
    return "dueDate must be a YYYY-MM-DD string";
  }
  if ("status" in body && body.status !== "open" && body.status !== "done" && body.status !== "archived") {
    return "status must be 'open', 'done' or 'archived'";
  }
  return null;
}

/**
 * recurEveryDays type normalization (#84, PR #81): the web form and MCP send
 * numbers, but a raw-HTTP resend of a stored value as a string ("2" for 2)
 * must keep reading as the no-op the ADR-23 legacy tolerance detects with a
 * strict !== against the stored number — so numeric strings are coerced
 * BEFORE the guards compare, and everything else non-null must be a positive
 * integer (the promise the MCP schema already makes). Mutates body in place;
 * returns the 400 message or null. categoryId/goalId deliberately get no
 * such coercion — they carry no resend-tolerance semantics.
 */
export function normalizeRecurInput(body: Record<string, unknown>): string | null {
  if (!("recurEveryDays" in body) || body.recurEveryDays == null) return null;
  const raw = body.recurEveryDays;
  const value = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
  if (!Number.isInteger(value) || (value as number) < 1) {
    return "recurEveryDays must be a positive integer (days)";
  }
  body.recurEveryDays = value;
  return null;
}

// FK targets are validated up front (#84): a null/absent/nonexistent
// categoryId used to die as the NOT NULL / FK constraint's raw 500 mid-
// transaction (PR #77) — atomic, but unhelpful — and a nonexistent goalId
// the same way. The existence checks make the 400 name the real problem.
export function categoryIdError(id: unknown): string | null {
  if (!Number.isInteger(id) || (id as number) < 1) return "categoryId must be a positive integer";
  if (!db.prepare("SELECT 1 FROM categories WHERE id = ?").get(id)) return "category not found";
  return null;
}

export function goalIdError(id: unknown): string | null {
  if (!Number.isInteger(id) || (id as number) < 1) return "goalId must be a positive integer or null";
  if (!db.prepare("SELECT 1 FROM goals WHERE id = ?").get(id)) return "goal not found";
  return null;
}

/**
 * Any-status check on purpose: done and archived subtasks can be revived by a
 * plain status write (reopen / un-archive), so a recurring row in any state
 * blocks the flip to 'sequential' — otherwise the ban would be one reopen away
 * from moot.
 */
export function hasRecurringSubtask(parentId: number): boolean {
  return Boolean(
    db
      .prepare("SELECT 1 FROM tasks WHERE parent_id = ? AND recur_every_days IS NOT NULL LIMIT 1")
      .get(parentId),
  );
}

/**
 * Reopen a done parent because an open subtask (re)appeared under it (#111,
 * ADR-32): subtask created (single or batch), adopted via reparent, reopened,
 * or un-archived. Deletes the parent's latest completion row (ADR-5 — this
 * is exactly the auto-completion being undone; a harmless no-op on a legacy
 * done parent without one) and clears snooze/block like every other reopen
 * (ADR-17). Must run inside the caller's transaction. No-op unless the parent
 * is actually done: an open parent needs no reopening, and an archived one is
 * left alone on purpose — reviving it implicitly is what #104 item 1 declined
 * (see ARCHIVED_PARENT_ERROR). Archived parents still reach here from the
 * un-archive path — archiving a ROOT is a plain column write that does not
 * cascade, so open children under an archived root remain reachable that way.
 */
export function reopenDoneParent(parentId: number): void {
  const parent = db.prepare("SELECT status FROM tasks WHERE id = ?").get(parentId) as
    | { status: string }
    | undefined;
  if (parent?.status !== "done") return;
  undoLatestCompletion(parentId);
  db.prepare(
    "UPDATE tasks SET status = 'open', completed_at = NULL, deferred_until = NULL, blocked = 0 WHERE id = ?",
  ).run(parentId);
}

/**
 * Availability window (#33, ADR-20) — shared POST/PATCH validation. The
 * window is all-or-none: windowDays (weekday integers 0–6, JS getDay
 * convention), windowStart and windowEnd ("HH:MM", end may be "24:00" for
 * end-of-day) are set together, or cleared together via `windowDays: null`.
 * [start, end) with end <= start rejected: overnight windows are ambiguous
 * with a weekday set and stay a follow-up (approximate with 22:00–24:00).
 * Days are normalized (deduplicated, sorted) before storage as JSON text.
 */
export function parseWindowInput(
  body: Record<string, unknown>,
):
  | { ok: false; error: string }
  | { ok: true; present: false }
  | { ok: true; present: true; days: string | null; start: string | null; end: string | null } {
  if (!["windowDays", "windowStart", "windowEnd"].some((k) => k in body)) {
    return { ok: true, present: false };
  }
  const days = body.windowDays ?? null;
  const start = body.windowStart ?? null;
  const end = body.windowEnd ?? null;
  if (days === null && start === null && end === null) {
    return { ok: true, present: true, days: null, start: null, end: null };
  }
  if (days === null || start === null || end === null) {
    return {
      ok: false,
      error:
        "availability window is all-or-none: set windowDays, windowStart and windowEnd together, or windowDays: null to clear",
    };
  }
  if (
    !Array.isArray(days) ||
    days.length === 0 ||
    days.some((d) => !Number.isInteger(d) || (d as number) < 0 || (d as number) > 6)
  ) {
    return { ok: false, error: "windowDays must be a non-empty array of weekday integers 0-6 (0 = Sunday)" };
  }
  if (typeof start !== "string" || !TIME_RE.test(start)) {
    return { ok: false, error: "windowStart must be HH:MM (00:00-23:59)" };
  }
  if (typeof end !== "string" || !(TIME_RE.test(end) || end === "24:00")) {
    return { ok: false, error: "windowEnd must be HH:MM (up to 24:00 for end-of-day)" };
  }
  // Zero-padded HH:MM compares correctly as a string ("24:00" sorts last).
  if (end <= start) {
    return {
      ok: false,
      error:
        "windowEnd must be after windowStart — overnight windows are not supported yet, approximate with e.g. 22:00-24:00",
    };
  }
  const normalized = [...new Set(days as number[])].sort((a, b) => a - b);
  return { ok: true, present: true, days: JSON.stringify(normalized), start, end };
}

export type WriteError = { status: number; error: string };

/**
 * The POST /api/tasks core — validation, insert and the #111 reopen hook,
 * exactly as the route ran them inline before #31. Returns the new row id;
 * the route turns it into the 201 payload, the assistant's apply step maps
 * a draft id onto it.
 */
export function createTaskWrite(body: Record<string, unknown>): WriteError | { id: number } {
  const { title, description, categoryId, goalId, parentId, impact, effortMinutes, dueDate } = body;
  if (!title || typeof title !== "string" || !title.trim()) {
    return { status: 400, error: "title is required" };
  }
  const shapeError = fieldShapeError(body);
  if (shapeError) return { status: 400, error: shapeError };
  const recurError = normalizeRecurInput(body);
  if (recurError) return { status: 400, error: recurError };
  const recurEveryDays = body.recurEveryDays as number | null | undefined;

  let parent:
    | {
        grandparentId: number | null;
        orderMode: string;
        goalId: number | null;
        categoryId: number;
        impact: number;
        status: string;
      }
    | undefined;
  if (parentId != null) {
    // Shape check first: a non-integer parentId used to reach the driver as
    // a binding TypeError (raw 500) instead of an honest 400 (#84).
    if (!Number.isInteger(parentId) || (parentId as number) < 1) {
      return { status: 400, error: "parentId must be a positive integer" };
    }
    parent = db
      .prepare(
        `SELECT parent_id AS grandparentId, subtask_order_mode AS orderMode,
                goal_id AS goalId, category_id AS categoryId, impact, status
         FROM tasks WHERE id = ?`,
      )
      .get(parentId) as typeof parent;
    // A clear 400 instead of the FK violation's opaque 500.
    if (!parent) return { status: 400, error: "parent task not found" };
    if (parent.grandparentId != null) {
      return { status: 400, error: NESTED_BREAKDOWN_ERROR };
    }
    // #104 item 1 — the create-path twin of the reparent guard. A new row is
    // always open, so this one needs no status check on the child.
    if (parent.status === "archived") {
      return { status: 400, error: ARCHIVED_PARENT_ERROR };
    }
    // #66 (ADR-23): a NEW subtask may not bring a recurrence into a
    // sequential breakdown. (The batch endpoint needs no twin check — its
    // INSERT has no recurrence column at all.)
    if (recurEveryDays != null && parent.orderMode === "sequential") {
      return { status: 400, error: RECURRING_SEQUENTIAL_ERROR };
    }
    // #84: the single-create path inherits goal and category exactly like
    // the batch; a conflicting explicit value is divergence and rejected
    // (see SUBTASK_GOAL_ERROR above). goalId: null counts as "not specified"
    // — at create it has never meant "unlink", the web form sends it for
    // every goal-less create.
    if (goalId != null) {
      const gError = goalIdError(goalId);
      if (gError) return { status: 400, error: gError };
      if (goalId !== parent.goalId) return { status: 400, error: SUBTASK_GOAL_ERROR };
    }
    if (categoryId != null) {
      const cError = categoryIdError(categoryId);
      if (cError) return { status: 400, error: cError };
      if (categoryId !== parent.categoryId) {
        return { status: 400, error: SUBTASK_CATEGORY_ERROR };
      }
    }
  } else {
    if (categoryId == null) {
      return { status: 400, error: "categoryId is required" };
    }
    const cError = categoryIdError(categoryId);
    if (cError) return { status: 400, error: cError };
    if (goalId != null) {
      const gError = goalIdError(goalId);
      if (gError) return { status: 400, error: gError };
    }
  }
  // The row's effective links: inherited on the parentId path (whether the
  // caller omitted them or resent the parent's own values), the caller's on
  // a root create.
  const effectiveGoalId = parent ? parent.goalId : ((goalId as number | null | undefined) ?? null);
  const effectiveCategoryId = parent ? parent.categoryId : (categoryId as number);

  // ADR-4 gate (#65): impact rates leverage toward a goal, so without a goal
  // only the neutral default 3 is accepted (the web form sends exactly that
  // for goal-less creates). The API is the enforcement point — the MCP
  // catalog and the web form both lean on this rejection rather than
  // duplicating it. Judged against the EFFECTIVE goal (#84): a subtask under
  // a goal-linked parent rates its inherited goal, while the goal-less
  // sibling-ranking exception (#76) stays batch-only.
  if (impact != null) {
    if (!Number.isInteger(impact) || (impact as number) < 1 || (impact as number) > 5) {
      return { status: 400, error: "impact must be an integer between 1 and 5" };
    }
    if (effectiveGoalId == null && impact !== 3) {
      return { status: 400, error: IMPACT_REQUIRES_GOAL };
    }
  }
  const win = parseWindowInput(body);
  if (!win.ok) return { status: 400, error: win.error };
  const window = win.present ? win : { days: null, start: null, end: null };
  const result = db.transaction(() => {
    const r = db
      .prepare(
        `INSERT INTO tasks (title, description, category_id, goal_id, parent_id, impact, effort_minutes, due_date, recur_every_days, window_days, window_start, window_end, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        title.trim(),
        description ?? null,
        effectiveCategoryId,
        effectiveGoalId,
        parentId ?? null,
        // Omitted impact defaults to the parent's rating on the parentId path —
        // batch parity with `s.impact ?? parent.impact` below — else neutral 3.
        impact ?? parent?.impact ?? 3,
        effortMinutes ?? null,
        dueDate ?? null,
        recurEveryDays ?? null,
        window.days,
        window.start,
        window.end,
        new Date().toISOString(),
      );
    // A new open subtask under a DONE parent reopens it (#111, ADR-32) — same
    // rule as the batch endpoint, so no creation path can leave an open child
    // under a done parent.
    if (parent?.status === "done") reopenDoneParent(parentId as number);
    return r;
  })();
  return { id: Number(result.lastInsertRowid) };
}

export interface SubtaskInput {
  title: string;
  description?: string | null;
  effortMinutes?: number | null;
  impact?: number | null;
}

/**
 * The POST /api/tasks/:id/subtasks core — one atomic batch under a root
 * parent, with the same guards and inheritance the route ran inline before
 * #31. Returns the created row ids in batch order.
 */
export function createSubtasksWrite(
  parentId: number,
  subtasks: unknown,
  orderMode: unknown,
): WriteError | { ids: number[] } {
  const parent = db
    .prepare(
      `SELECT id, parent_id AS parentId, status, category_id AS categoryId,
              goal_id AS goalId, impact, subtask_order_mode AS subtaskOrderMode
       FROM tasks WHERE id = ?`,
    )
    .get(parentId) as
    | {
        id: number;
        parentId: number | null;
        status: string;
        categoryId: number;
        goalId: number | null;
        impact: number;
        subtaskOrderMode: string;
      }
    | undefined;
  if (!parent) return { status: 404, error: "task not found" };
  if (parent.parentId != null) {
    return { status: 400, error: NESTED_BREAKDOWN_ERROR };
  }
  // #104 item 1: same guard as the single create — the batch rows are open by
  // construction too (the INSERT below has no status column).
  if (parent.status === "archived") {
    return { status: 400, error: ARCHIVED_PARENT_ERROR };
  }

  if (!Array.isArray(subtasks) || subtasks.length === 0) {
    return { status: 400, error: "subtasks array is required" };
  }
  for (const s of subtasks as Record<string, unknown>[]) {
    if (!s.title || typeof s.title !== "string" || !s.title.trim()) {
      return { status: 400, error: "every subtask needs a title" };
    }
    // Range check only — a clean 400 instead of the CHECK constraint's raw
    // 500. The ADR-4 goal gate is deliberately NOT applied here, see below.
    if (s.impact != null && (!Number.isInteger(s.impact) || (s.impact as number) < 1 || (s.impact as number) > 5)) {
      return { status: 400, error: "impact must be an integer between 1 and 5" };
    }
    // Same shape sweep as POST / (#84): a non-string description or a
    // non-numeric effortMinutes used to blow up as a better-sqlite3 binding
    // TypeError mid-transaction — rolled back, but a raw 500.
    if (s.description != null && typeof s.description !== "string") {
      return { status: 400, error: "subtask description must be a string" };
    }
    if (s.effortMinutes != null && (!Number.isInteger(s.effortMinutes) || (s.effortMinutes as number) < 1)) {
      return { status: 400, error: "subtask effortMinutes must be a positive integer" };
    }
  }
  // "Do in order" travels with the breakdown itself (#23) — persisted on the
  // parent in the same transaction, so batch and mode cannot disagree.
  if (orderMode !== undefined && orderMode !== "parallel" && orderMode !== "sequential") {
    return { status: 400, error: "orderMode must be 'parallel' or 'sequential'" };
  }
  // Transition guard (#66, ADR-23): switching the parent to 'sequential' while
  // a recurring subtask already sits underneath would create the forbidden
  // combination in the same write. Re-sending 'sequential' on an already-
  // sequential parent is a no-op and stays accepted (legacy tolerance). The
  // batch rows themselves cannot smuggle a recurrence — the INSERT below has
  // no recurrence column.
  if (
    orderMode === "sequential" &&
    parent.subtaskOrderMode !== "sequential" &&
    hasRecurringSubtask(parent.id)
  ) {
    return { status: 400, error: RECURRING_SEQUENTIAL_ERROR };
  }

  // ADR-4 exception, documented on purpose (#76): per-subtask impact is
  // accepted here WITHOUT the impact-requires-goal gate POST / and PATCH
  // enforce. Subtasks inherit the parent's goal, so under a goal-linked
  // parent the rating is ordinary ADR-4 impact — and under a goal-less
  // parent a breakdown's ratings rank the siblings relative to each other:
  // the AI breakdown deliberately emits them and the review panel sends them
  // verbatim (client/src/lib/impact.ts names goal-less breakdowns as a
  // legitimate source of non-neutral goal-less impact). Gating here would
  // 400 the accept step of every AI breakdown of a goal-less parent, while
  // the `?? parent.impact` fallback below already inherits a possibly
  // grandfathered non-neutral rating anyway. Only the 1–5 range is enforced.
  const insert = db.prepare(
    `INSERT INTO tasks (title, description, category_id, goal_id, parent_id, impact, effort_minutes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const ids = db.transaction(() => {
    if (orderMode) {
      db.prepare("UPDATE tasks SET subtask_order_mode = ? WHERE id = ?").run(orderMode, parent.id);
    }
    const created: number[] = [];
    for (const s of subtasks as SubtaskInput[]) {
      const r = insert.run(
        s.title.trim(),
        // Optional provenance line, e.g. "Exercise 7 · 8 pts · ~45 min · exam.pdf" (#28)
        s.description ?? null,
        parent.categoryId,
        parent.goalId ?? null,
        parent.id,
        s.impact ?? parent.impact,
        s.effortMinutes ?? null,
        new Date().toISOString(),
      );
      created.push(Number(r.lastInsertRowid));
    }
    // New open subtasks under a DONE parent reopen it (#111, ADR-32): status
    // open, completed_at cleared, and the latest completion row deleted —
    // the auto-completion undone (ADR-5).
    if (parent.status === "done") reopenDoneParent(parent.id);
    return created;
  })();

  return { ids };
}
