import { Router } from "express";
import { db, getSetting } from "../db.js";
import {
  clearCurrentDraw,
  clearDanglingDraw,
  getCurrentDrawTaskId,
  heldBackSql,
  isRestorable,
  toTaskPayload,
  type RestorableTask,
} from "../services/drawService.js";
import {
  completeTask,
  undoLatestCompletion,
  wasRecentlyDrawn,
  type TaskRow,
} from "../services/gamificationService.js";
import { AiError } from "../services/aiService.js";
import { getOrCreateCardArt } from "../services/cardArtService.js";
import { startTimer } from "./timer.js";

export const tasksRouter = Router();

const TASK_SELECT = `
  SELECT id, title, description,
         category_id AS categoryId, goal_id AS goalId, parent_id AS parentId,
         impact, effort_minutes AS effortMinutes, due_date AS dueDate,
         recur_every_days AS recurEveryDays, status,
         created_at AS createdAt, completed_at AS completedAt,
         last_drawn_at AS lastDrawnAt, deferred_until AS deferredUntil, blocked,
         subtask_order_mode AS subtaskOrderMode,
         window_days AS windowDays, window_start AS windowStart, window_end AS windowEnd,
         EXISTS(SELECT 1 FROM tasks c WHERE c.parent_id = tasks.id AND c.status = 'open') AS hasOpenChildren,
         ${heldBackSql("tasks")} AS heldBack,
         CASE
           WHEN EXISTS(SELECT 1 FROM tasks c WHERE c.parent_id = tasks.id AND c.status = 'open')
             THEN (SELECT SUM(c.effort_minutes) FROM tasks c WHERE c.parent_id = tasks.id AND c.status = 'open')
           ELSE effort_minutes
         END AS remainingEffortMinutes
  FROM tasks`;

function getTask(id: number) {
  const task = db.prepare(`${TASK_SELECT} WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined;
  return task && toTaskPayload(task);
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const IMPACT_REQUIRES_GOAL =
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
const NESTED_BREAKDOWN_ERROR =
  "breakdowns are one level deep (ADR-16): this task is itself a subtask and cannot be " +
  "broken down further — add the steps as additional subtasks of its root parent instead";

// Recurring × sequential ban (#66, ADR-23): a recurring step never closes —
// completing it advances its due date instead (ADR-6) — so under a
// 'sequential' parent it would hold every later sibling back forever
// (heldBackSql only frees a step when the one in front stops being open).
// The combination is rejected on every path that could CREATE it: subtask
// creation, recurrence edits, and mode flips. Pre-existing rows stay
// operable — a no-op resend of the stored value passes, mirroring the ADR-4
// impact gate below.
const RECURRING_SEQUENTIAL_ERROR =
  "recurring subtasks cannot be part of a sequential breakdown (ADR-23): a recurring step " +
  "never closes — completing it advances its due date (ADR-6) — so it would hold every " +
  "later step back forever. Drop the recurrence, or keep the parent's subtasks parallel";

/**
 * Any-status check on purpose: done and archived subtasks can be revived by a
 * plain status write (reopen / un-archive), so a recurring row in any state
 * blocks the flip to 'sequential' — otherwise the ban would be one reopen away
 * from moot.
 */
function hasRecurringSubtask(parentId: number): boolean {
  return Boolean(
    db
      .prepare("SELECT 1 FROM tasks WHERE parent_id = ? AND recur_every_days IS NOT NULL LIMIT 1")
      .get(parentId),
  );
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
function parseWindowInput(
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

tasksRouter.get("/", (req, res) => {
  const status = (req.query.status as string) || "open";
  const conditions: string[] = ["parent_id IS NULL"];
  const params: unknown[] = [];

  if (status !== "all") {
    conditions.push("status = ?");
    params.push(status);
  }
  if (req.query.categoryId) {
    conditions.push("category_id = ?");
    params.push(Number(req.query.categoryId));
  }
  if (req.query.goalId) {
    conditions.push("goal_id = ?");
    params.push(Number(req.query.goalId));
  }

  const roots = db
    .prepare(`${TASK_SELECT} WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC`)
    .all(...params) as Record<string, unknown>[];

  // (created_at, id) is the canonical creation order — the same order the
  // sequential hold-back predicate uses (#23), so the queue reads top-down.
  const childStmt = db.prepare(
    `${TASK_SELECT} WHERE parent_id = ? AND status != 'archived' ORDER BY created_at ASC, id ASC`,
  );
  for (const root of roots) {
    toTaskPayload(root);
    root.subtasks = (childStmt.all(root.id) as Record<string, unknown>[]).map(toTaskPayload);
  }
  res.json(roots);
});

tasksRouter.post("/", (req, res) => {
  const { title, description, categoryId, goalId, parentId, impact, effortMinutes, dueDate, recurEveryDays } =
    req.body ?? {};
  if (!title || typeof title !== "string" || !title.trim()) {
    return res.status(400).json({ error: "title is required" });
  }
  if (!categoryId) {
    return res.status(400).json({ error: "categoryId is required" });
  }
  // ADR-4 gate (#65): impact rates leverage toward a goal, so without a
  // goalId only the neutral default 3 is accepted (the web form sends exactly
  // that for goal-less creates). The API is the enforcement point — the MCP
  // catalog and the web form both lean on this rejection rather than
  // duplicating it.
  if (impact != null) {
    if (!Number.isInteger(impact) || impact < 1 || impact > 5) {
      return res.status(400).json({ error: "impact must be an integer between 1 and 5" });
    }
    if (goalId == null && impact !== 3) {
      return res.status(400).json({ error: IMPACT_REQUIRES_GOAL });
    }
  }
  if (parentId != null) {
    const parentRow = db
      .prepare("SELECT parent_id AS grandparentId, subtask_order_mode AS orderMode FROM tasks WHERE id = ?")
      .get(parentId) as { grandparentId: number | null; orderMode: string } | undefined;
    // A clear 400 instead of the FK violation's opaque 500.
    if (!parentRow) return res.status(400).json({ error: "parent task not found" });
    if (parentRow.grandparentId != null) {
      return res.status(400).json({ error: NESTED_BREAKDOWN_ERROR });
    }
    // #66 (ADR-23): a NEW subtask may not bring a recurrence into a
    // sequential breakdown. (The batch endpoint needs no twin check — its
    // INSERT has no recurrence column at all.)
    if (recurEveryDays != null && parentRow.orderMode === "sequential") {
      return res.status(400).json({ error: RECURRING_SEQUENTIAL_ERROR });
    }
  }
  const win = parseWindowInput(req.body ?? {});
  if (!win.ok) return res.status(400).json({ error: win.error });
  const window = win.present ? win : { days: null, start: null, end: null };
  const result = db
    .prepare(
      `INSERT INTO tasks (title, description, category_id, goal_id, parent_id, impact, effort_minutes, due_date, recur_every_days, window_days, window_start, window_end, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      title.trim(),
      description ?? null,
      categoryId,
      goalId ?? null,
      parentId ?? null,
      impact ?? 3,
      effortMinutes ?? null,
      dueDate ?? null,
      recurEveryDays ?? null,
      window.days,
      window.start,
      window.end,
      new Date().toISOString(),
    );
  res.status(201).json(getTask(Number(result.lastInsertRowid)));
});

tasksRouter.post("/:id/subtasks", (req, res) => {
  const parent = getTask(Number(req.params.id));
  if (!parent) return res.status(404).json({ error: "task not found" });
  if (parent.parentId != null) {
    return res.status(400).json({ error: NESTED_BREAKDOWN_ERROR });
  }

  const subtasks = req.body?.subtasks;
  if (!Array.isArray(subtasks) || subtasks.length === 0) {
    return res.status(400).json({ error: "subtasks array is required" });
  }
  for (const s of subtasks) {
    if (!s.title || typeof s.title !== "string" || !s.title.trim()) {
      return res.status(400).json({ error: "every subtask needs a title" });
    }
  }
  // "Do in order" travels with the breakdown itself (#23) — persisted on the
  // parent in the same transaction, so batch and mode cannot disagree.
  const orderMode = req.body?.orderMode;
  if (orderMode !== undefined && orderMode !== "parallel" && orderMode !== "sequential") {
    return res.status(400).json({ error: "orderMode must be 'parallel' or 'sequential'" });
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
    hasRecurringSubtask(parent.id as number)
  ) {
    return res.status(400).json({ error: RECURRING_SEQUENTIAL_ERROR });
  }

  const insert = db.prepare(
    `INSERT INTO tasks (title, description, category_id, goal_id, parent_id, impact, effort_minutes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const created = db.transaction(() => {
    if (orderMode) {
      db.prepare("UPDATE tasks SET subtask_order_mode = ? WHERE id = ?").run(orderMode, parent.id);
    }
    const ids: number[] = [];
    for (const s of subtasks) {
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
      ids.push(Number(r.lastInsertRowid));
    }
    return ids.map((id) => getTask(id));
  })();

  res.status(201).json(created);
});

tasksRouter.patch("/:id", (req, res) => {
  const id = Number(req.params.id);
  const raw = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as
    | (TaskRow & { goal_id: number | null; parent_id: number | null; subtask_order_mode: string })
    | undefined;
  if (!raw) return res.status(404).json({ error: "task not found" });

  const body = req.body ?? {};

  // Completion goes through the gamification path.
  if (body.status === "done" && raw.status === "open") {
    const openChildren = db
      .prepare("SELECT COUNT(*) AS n FROM tasks WHERE parent_id = ? AND status = 'open'")
      .get(id) as { n: number };
    if (openChildren.n > 0) {
      return res.status(409).json({ error: "complete all subtasks first" });
    }
    // The drawn-card bonus is derived server-side, never from a client flag
    // (ADR-13): the persisted current draw survives reloads and long pauses;
    // the 6h last_drawn_at heuristic still covers a card completed shortly
    // after a redraw replaced it.
    const drawn = getCurrentDrawTaskId() === id || wasRecentlyDrawn(raw);
    const result = db.transaction(() => completeTask(raw, drawn))();
    return res.json({ task: getTask(id), ...result });
  }

  // Reopening: undo the latest completion so XP stays honest. A reopened
  // task starts fresh in the deck — leftover snooze/block state is cleared
  // (ADR-17), same as on completion.
  if (body.status === "open" && raw.status === "done") {
    db.transaction(() => {
      undoLatestCompletion(id);
      db.prepare(
        "UPDATE tasks SET status = 'open', completed_at = NULL, deferred_until = NULL, blocked = 0 WHERE id = ?",
      ).run(id);
    })();
    return res.json({ task: getTask(id) });
  }

  // Snooze/block fields (ADR-17). deferredUntil is normalized to a UTC ISO
  // string because the pool predicate compares it lexicographically in SQL.
  if ("deferredUntil" in body && body.deferredUntil !== null) {
    const v = body.deferredUntil;
    if (typeof v !== "string" || Number.isNaN(new Date(v).getTime())) {
      return res.status(400).json({ error: "deferredUntil must be null or an ISO datetime" });
    }
    body.deferredUntil = new Date(v).toISOString();
  }
  if ("blocked" in body) {
    if (typeof body.blocked !== "boolean") {
      return res.status(400).json({ error: "blocked must be a boolean" });
    }
    body.blocked = body.blocked ? 1 : 0;
  }
  // Sequential subtask mode (#23): a plain column write — which subtask is
  // exposed to the draw stays derived from it (ADR-18), so the toggle needs
  // no bookkeeping beyond this validation.
  if ("subtaskOrderMode" in body && body.subtaskOrderMode !== "parallel" && body.subtaskOrderMode !== "sequential") {
    return res.status(400).json({ error: "subtaskOrderMode must be 'parallel' or 'sequential'" });
  }
  // Recurring × sequential transition guards (#66, ADR-23). Both directions
  // are checked against the STORED counterpart, so the combination can never
  // be newly created, while no-op resends of a stored value keep legacy rows
  // (a pre-ban database) editable — the same tolerance the ADR-4 gate below
  // extends to grandfathered impact values.
  if (
    body.subtaskOrderMode === "sequential" &&
    raw.subtask_order_mode !== "sequential" &&
    hasRecurringSubtask(id)
  ) {
    return res.status(400).json({ error: RECURRING_SEQUENTIAL_ERROR });
  }
  if (
    "recurEveryDays" in body &&
    body.recurEveryDays != null &&
    body.recurEveryDays !== raw.recur_every_days &&
    raw.parent_id != null
  ) {
    const parentMode = db
      .prepare("SELECT subtask_order_mode AS mode FROM tasks WHERE id = ?")
      .get(raw.parent_id) as { mode: string } | undefined;
    if (parentMode?.mode === "sequential") {
      return res.status(400).json({ error: RECURRING_SEQUENTIAL_ERROR });
    }
  }
  // ADR-4 gate (#65): impact rates leverage toward a goal, so on a task that
  // is (or stays) goal-less only the neutral default 3 — or a no-op resend of
  // the stored value, which the edit form emits for grandfathered tasks (goal
  // deletion keeps the historical rating) — is accepted. Deliberately
  // unlinking the goal resets impact to 3 whether or not the client sends the
  // explicit reset (client/src/lib/impact.ts does): the rating described
  // leverage toward the goal that was just removed.
  if ("impact" in body) {
    // The column is NOT NULL with default 3, so null can only mean "reset".
    if (body.impact == null) body.impact = 3;
    if (!Number.isInteger(body.impact) || (body.impact as number) < 1 || (body.impact as number) > 5) {
      return res.status(400).json({ error: "impact must be an integer between 1 and 5" });
    }
  }
  const goalAfter = "goalId" in body ? body.goalId : raw.goal_id;
  if (goalAfter == null) {
    const unlinking = "goalId" in body && raw.goal_id != null;
    if (unlinking) {
      if ("impact" in body && body.impact !== 3) {
        return res.status(400).json({
          error:
            "unlinking the goal resets impact to the neutral default 3 (ADR-4) — to rate " +
            "impact, set it together with a goalId",
        });
      }
      body.impact = 3; // the server owns the unlink reset
    } else if ("impact" in body && body.impact !== 3 && body.impact !== raw.impact) {
      return res.status(400).json({ error: IMPACT_REQUIRES_GOAL });
    }
  }
  // Availability window (#33): validated and normalized as a trio — the
  // three body keys are rewritten so the generic field map below always
  // writes all three columns together (all-or-none by construction).
  const win = parseWindowInput(body);
  if (!win.ok) return res.status(400).json({ error: win.error });
  if (win.present) {
    body.windowDays = win.days;
    body.windowStart = win.start;
    body.windowEnd = win.end;
  }

  const fields: Record<string, string> = {
    title: "title",
    description: "description",
    categoryId: "category_id",
    goalId: "goal_id",
    impact: "impact",
    effortMinutes: "effort_minutes",
    dueDate: "due_date",
    recurEveryDays: "recur_every_days",
    status: "status",
    deferredUntil: "deferred_until",
    blocked: "blocked",
    subtaskOrderMode: "subtask_order_mode",
    windowDays: "window_days",
    windowStart: "window_start",
    windowEnd: "window_end",
  };
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [key, column] of Object.entries(fields)) {
    if (key in body) {
      sets.push(`${column} = ?`);
      params.push(body[key]);
    }
  }
  if (sets.length === 0) return res.status(400).json({ error: "nothing to update" });

  db.transaction(() => {
    db.prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`).run(...params, id);
    // Subtasks follow their parent's goal: goal counts and the goal-filtered
    // draw key off each row's own goal_id, so a goal change must cascade to
    // the children (breakdown is one level deep — only roots can be split).
    if ("goalId" in body) {
      db.prepare("UPDATE tasks SET goal_id = ? WHERE parent_id = ?").run(body.goalId ?? null, id);
    }
    // Category cascades the same way (#44) — but only to OPEN subtasks:
    // done/archived rows are historical records, and completion stats and the
    // activity feed should keep attributing them to the category they were
    // actually finished under. The draw pool only ever contains open tasks,
    // so open rows are all consistency requires; a reopened subtask that now
    // mismatches its parent stays manually repairable via subtask edit (#38).
    if ("categoryId" in body) {
      db.prepare("UPDATE tasks SET category_id = ? WHERE parent_id = ? AND status = 'open'").run(
        body.categoryId,
        id,
      );
    }
  })();

  const task = getTask(id)!;
  // Snoozing/blocking the current draw dismisses the card, so the persisted
  // pointer is cleared eagerly here, mirroring completeTask() — this is the
  // one sideways mutation that must not wait for GET /api/draw/current's
  // lazy validation (ADR-13): a snooze wears off (and a block can be woken
  // from the Tasks page) without any GET in between, and the once-again
  // restorable pointer would resurrect a card the user explicitly sent away
  // (ADR-17).
  if (
    ("deferredUntil" in body || "blocked" in body) &&
    getCurrentDrawTaskId() === id &&
    !isRestorable(task as unknown as RestorableTask, getSetting("max_draw_effort", 30), new Date())
  ) {
    clearCurrentDraw(id);
  }
  res.json({ task });
});

// AI card art (#27, ADR-22): serves the cached SVG or generates it exactly
// once per task (sanitized before storage). Degraded mode answers 503
// ai_not_configured, matching routes/ai.ts — the client swallows every
// failure into "no art", so this endpoint never blocks or breaks the reveal.
tasksRouter.get("/:id/card-art", async (req, res) => {
  try {
    res.json(await getOrCreateCardArt(Number(req.params.id)));
  } catch (e) {
    if (e instanceof AiError) return res.status(e.status).json({ error: e.message });
    res.status(500).json({ error: e instanceof Error ? e.message : "unknown error" });
  }
});

tasksRouter.post("/:id/timer/start", (req, res) => {
  const result = startTimer(Number(req.params.id));
  if (result.error) return res.status(result.status!).json({ error: result.error });
  res.json({ ok: true });
});

tasksRouter.delete("/:id", (req, res) => {
  const id = Number(req.params.id);
  const result = db.prepare("DELETE FROM tasks WHERE id = ?").run(id);
  if (result.changes === 0) return res.status(404).json({ error: "task not found" });
  // A deleted card leaves the deck — whether it was deleted directly or
  // cascade-deleted with its parent. Cleared on row absence, not id match:
  // a freed id (no AUTOINCREMENT) could be re-bound to the next captured
  // task before the lazy restore validation ever runs.
  clearDanglingDraw();
  res.json({ ok: true });
});
