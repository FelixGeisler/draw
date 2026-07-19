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
  type CompletionResult,
  type TaskRow,
} from "../services/gamificationService.js";
import { AiError } from "../services/aiService.js";
import { getOrCreateCardArt, regenerateCardArt } from "../services/cardArtService.js";
import {
  ARCHIVED_PARENT_ERROR,
  IMPACT_REQUIRES_GOAL,
  NESTED_BREAKDOWN_ERROR,
  RECURRING_SEQUENTIAL_ERROR,
  SUBTASK_CATEGORY_ERROR,
  SUBTASK_GOAL_ERROR,
  categoryIdError,
  createSubtasksWrite,
  createTaskWrite,
  fieldShapeError,
  goalIdError,
  hasRecurringSubtask,
  normalizeRecurInput,
  parseWindowInput,
  reopenDoneParent,
} from "../services/taskWrites.js";
import { startTimer } from "./timer.js";

export const tasksRouter = Router();

// remainingEffortMinutes (#111, ADR-32): while ANY non-archived subtask
// exists the subtasks own the estimate — the sum over OPEN ones (NULL when
// none are open or none estimated), NEVER the parent's own stored value. Only
// a task with zero non-archived children (a true leaf, or a parent whose
// children were all moved away or archived — PR #102's revival) reports its
// own effort_minutes. The stored parent estimate is ignored, not nulled: it
// keeps the sizing history and becomes meaningful again on revival (ADR-2 —
// derive at read time, keep stored fields as source data).
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
         EXISTS(SELECT 1 FROM tasks c WHERE c.parent_id = tasks.id AND c.status != 'archived') AS hasNonArchivedChildren,
         ${heldBackSql("tasks")} AS heldBack,
         CASE
           WHEN EXISTS(SELECT 1 FROM tasks c WHERE c.parent_id = tasks.id AND c.status != 'archived')
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

// Shape/FK validation, window parsing, the moved error constants and the two
// creation cores live in services/taskWrites.ts since #31 — the assistant's
// atomic apply calls the same functions these routes do, so no invariant has
// two homes. PATCH-only guards stay here.

// The reparent direction of the ADR-16 ban (#100): a task that HAS subtasks
// cannot itself become one — adopting it would turn its children into
// invisible grandchildren. Children of ANY status count, matching
// hasRecurringSubtask's rationale below: a done/archived child is one status
// write away from being an open grandchild.
const PARENT_INTO_SUBTASK_ERROR =
  "a task with subtasks cannot become a subtask itself (ADR-16): its subtasks would nest two " +
  "levels deep — move the subtasks individually, or promote/delete them first";

// Archived → done (#122): rejected, not routed. The generic field write at the
// bottom of PATCH would set status = 'done' as a plain column write, skipping
// BOTH the completion branch above it — so no completeTask(), which means a
// done row with no `completions` row: zero XP, no achievements, no streak
// count, invisible to every derived surface (ADR-5) — and the parent-lifecycle
// hooks (#111, ADR-32), so a done parent would never notice its subtask
// finished. Routing it through completeTask() instead would mint XP for a row
// the user deliberately took off the board (split-in-place leftovers, ADR-21),
// and archived rows are excluded from the all-done predicate on both sides by
// design. The honest repair is the transition the router already supports:
// un-archive (status 'open', which reopens a done parent), then complete —
// that path pays out exactly once, through the one sanctioned door.
const ARCHIVED_TO_DONE_ERROR =
  "an archived task cannot be completed directly (ADR-5): reopen it first (status: 'open'), " +
  "then complete it — completing an archived row would leave a done task with no completion, " +
  "no XP and no parent lifecycle";


/**
 * Split-in-place part validation (#108) — pure, exported for unit tests.
 * Whole-body: any invalid part fails the entire request before a single row
 * is written. Length >= 2 because one part is a rename (use edit). Each part
 * needs a non-empty title and a positive-integer effortMinutes — required,
 * unlike the batch endpoint's optional estimate: the split exists to divide
 * a known-oversized estimate, so unestimated parts would defeat it. There is
 * deliberately NO effortMinutes <= max_draw_effort cap: a part may still be
 * too big — it can itself be split again (decomposition is unlimited by
 * repetition, not by depth). Shape checks ride on fieldShapeError.
 */
export function splitPartsError(parts: unknown): string | null {
  if (!Array.isArray(parts) || parts.length < 2) {
    return "parts must be an array of at least 2 parts — splitting into one part is a rename, use edit instead";
  }
  for (const p of parts) {
    if (p == null || typeof p !== "object" || Array.isArray(p)) {
      return "every part must be an object with title and effortMinutes";
    }
    const part = p as Record<string, unknown>;
    if (!("title" in part)) return "every part needs a title";
    if (part.effortMinutes == null) {
      return "every part needs effortMinutes (a positive integer)";
    }
    const shape = fieldShapeError(part);
    if (shape) return shape;
  }
  return null;
}

function hasNonArchivedSubtask(parentId: number): boolean {
  return Boolean(
    db
      .prepare("SELECT 1 FROM tasks WHERE parent_id = ? AND status != 'archived' LIMIT 1")
      .get(parentId),
  );
}

/**
 * The all-done predicate (#111, ADR-32) — pure, exported for unit tests:
 * >= 1 done subtask AND zero open ones; archived subtasks are ignored on
 * BOTH sides. So a split-in-place (#108) never satisfies it (the archived
 * original is replaced by open parts in the same transaction), while
 * archiving the last open subtask next to a done sibling does. All-archived
 * yields false — that parent has zero non-archived children and completes
 * as an ordinary leaf.
 */
export function breakdownAllDone(childStatuses: string[]): boolean {
  return (
    childStatuses.some((s) => s === "done") && !childStatuses.some((s) => s === "open")
  );
}

/**
 * Auto-complete an open, non-recurring parent whose breakdown just became
 * all-done (#111, ADR-32). Evaluated after every write that changes a
 * subtask's status (complete, archive, reopen, un-archive) or removes one
 * (DELETE — the trash button sits on every subtask row, so deleting the last
 * open step next to a done sibling is an everyday finisher); must run inside
 * the caller's transaction. Flows through completeTask() — a genuine
 * completion row (ADR-5), achievements, timer close, daily/streak count —
 * with effort overridden to 0 (the subtasks already earned the effort XP;
 * the floor makes it the symbolic 1 XP) and wasDrawn false (a parent with
 * children is never in the deck under rule 1, so it cannot have been the
 * gamble). Recurring parents are EXCLUDED: their completion advances the due
 * date while the subtasks would stay done, leaving every later occurrence an
 * empty shell — they simply stay open; manual completion follows ADR-6
 * unchanged.
 */
function maybeAutoCompleteParent(parentId: number): CompletionResult | null {
  const parent = db.prepare("SELECT * FROM tasks WHERE id = ?").get(parentId) as
    | (TaskRow & { parent_id: number | null })
    | undefined;
  if (!parent || parent.status !== "open" || parent.recur_every_days != null) return null;
  const statuses = (
    db.prepare("SELECT status FROM tasks WHERE parent_id = ?").all(parentId) as {
      status: string;
    }[]
  ).map((r) => r.status);
  if (!breakdownAllDone(statuses)) return null;
  return completeTask(parent, false, { effortMinutes: 0 });
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
  const body = (req.body ?? {}) as Record<string, unknown>;
  const result = createTaskWrite(body);
  if ("error" in result) return res.status(result.status).json({ error: result.error });
  res.status(201).json(getTask(result.id));
});

tasksRouter.post("/:id/subtasks", (req, res) => {
  const result = createSubtasksWrite(Number(req.params.id), req.body?.subtasks, req.body?.orderMode);
  if ("error" in result) return res.status(result.status).json({ error: result.error });
  res.status(201).json(result.ids.map((id) => getTask(id)));
});

// Split-in-place (#108): a too-big SUBTASK dead-ends — ADR-16 keeps the tree
// two levels, so it cannot be broken down further. Instead it is REPLACED by
// its parts as siblings at the same level; decomposition becomes unlimited by
// repetition, not by depth. The original is kept as ARCHIVED, never deleted:
// delete would cascade its time_entries and completions away (the ADR-21
// accepted limitation, which a routine planning action must not trigger),
// while an archived subtask falls out of every derived surface with NO write
// (the ADR-2/8.1 property) — the pool (status = 'open'), the Tasks page child
// list (status != 'archived'), the remainingEffortMinutes rollup (open
// children only), the sequential hold-back (open siblings only) and the
// parent-completion 409 gate (open-children count). There is deliberately no
// too-big gate on the original: the UI scopes the affordance to too-big rows,
// but coupling the endpoint to a settings value buys nothing.
tasksRouter.post("/:id/split", (req, res) => {
  const id = Number(req.params.id);
  const raw = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as
    | {
        id: number;
        parent_id: number | null;
        status: string;
        recur_every_days: number | null;
        impact: number;
        due_date: string | null;
        window_days: string | null;
        window_start: string | null;
        window_end: string | null;
        created_at: string;
      }
    | undefined;
  if (!raw) return res.status(404).json({ error: "task not found" });
  if (raw.parent_id == null) {
    return res.status(400).json({
      error:
        "splitting in place is for subtasks — break a too-big root task down into subtasks instead",
    });
  }
  if (raw.status !== "open") {
    return res
      .status(400)
      .json({ error: "only an open subtask can be split — a done or archived row has nothing to split" });
  }
  // Recurring × split is incoherent: parts are one-shot rows, and "which part
  // recurs?" has no answer. Same repair as ADR-23's: drop the recurrence
  // first, then split. (No drop-recurrence-with-flag convenience — the
  // surface stays small.)
  if (raw.recur_every_days != null) {
    return res.status(400).json({
      error:
        "a recurring subtask cannot be split — parts are one-shot rows, so no part could carry " +
        "the recurrence; drop the recurrence first, then split",
    });
  }
  // Whole-body validation BEFORE the transaction: any invalid part means
  // nothing is written.
  const partsError = splitPartsError(req.body?.parts);
  if (partsError) return res.status(400).json({ error: partsError });
  const parts = req.body.parts as { title: string; effortMinutes: number; description?: string }[];

  const parent = db
    .prepare("SELECT category_id AS categoryId, goal_id AS goalId FROM tasks WHERE id = ?")
    .get(raw.parent_id) as { categoryId: number; goalId: number | null };

  // Parts inherit exactly like the batch endpoint does by construction:
  // category_id/goal_id from the PARENT (a subtask's category stays editable
  // afterwards, but new rows of the breakdown start from the parent, like the
  // batch), impact from the ORIGINAL — the parts continue the same work — and
  // the original's due_date and availability window: deadline and doability
  // constraints describe the work, not the row. NOT inherited: snooze/block
  // (deferred_until NULL, blocked 0 — parts start fresh, even when the
  // original was snoozed/blocked), last_drawn_at, and recurrence — this
  // INSERT carries no recurrence column (like the batch), so parts under a
  // sequential parent can never mint the ADR-23 ban.
  //
  // created_at is adopted VERBATIM from the original (ADR-18 amendment): the
  // queue and the child list order by (created_at, id), so the parts sort
  // into the original's slot — ahead of every later-timestamp sibling, and
  // in array order among themselves via the new, higher ids. For siblings
  // sharing the original's exact timestamp (batch groups) exact in-slot
  // placement is impossible without mutating sibling rows — there is no
  // (created_at, id) between (T, id5) and (T, id6) for a new higher id — so
  // parts land at the end of that same-timestamp group (still ahead of
  // later-timestamp siblings); the explicit position column stays the named
  // escalation. Adopting created_at also inherits the original's staleness
  // base (ADR-17) — deliberate: the work has genuinely been lying around
  // since then.
  const insert = db.prepare(
    `INSERT INTO tasks (title, description, category_id, goal_id, parent_id, impact, effort_minutes, due_date, window_days, window_start, window_end, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const created = db.transaction(() => {
    const ids: number[] = [];
    for (const p of parts) {
      const r = insert.run(
        p.title.trim(),
        p.description ?? null,
        parent.categoryId,
        parent.goalId,
        raw.parent_id,
        raw.impact,
        p.effortMinutes,
        raw.due_date,
        raw.window_days,
        raw.window_start,
        raw.window_end,
        raw.created_at,
      );
      ids.push(Number(r.lastInsertRowid));
    }
    db.prepare("UPDATE tasks SET status = 'archived' WHERE id = ?").run(id);
    // The work session on the original is over — close its running time entry
    // at split time, mirroring what completion does (ADR-12). Its minutes
    // stay attributed to the original, whose stats survive archiving.
    db.prepare("UPDATE time_entries SET ended_at = ? WHERE task_id = ? AND ended_at IS NULL").run(
      new Date().toISOString(),
      id,
    );
    // The original can normally never BE the current draw (too big = not
    // drawable), but the endpoint has no size gate, so an API/MCP caller can
    // split the drawable-sized persisted draw. Archiving fails isRestorable
    // with no path back short of an explicit reopen, so ADR-13's lazy clear
    // would suffice — the eager clear is one line and keeps symmetry with
    // complete/delete.
    clearCurrentDraw(id);
    return ids.map((partId) => getTask(partId));
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

  // Request-shape 400s (#84) run before every write path — including the
  // completion/reopen branches below, which ignore extra fields rather than
  // write them: a malformed field in a mixed payload is a caller bug either
  // way. recurEveryDays is normalized here so the ADR-23 guards further down
  // compare the coerced number against the stored one.
  const shapeError = fieldShapeError(body);
  if (shapeError) return res.status(400).json({ error: shapeError });
  const recurError = normalizeRecurInput(body);
  if (recurError) return res.status(400).json({ error: recurError });
  if ("categoryId" in body) {
    const cError = categoryIdError(body.categoryId);
    if (cError) return res.status(400).json({ error: cError });
  }
  if ("goalId" in body && body.goalId != null) {
    const gError = goalIdError(body.goalId);
    if (gError) return res.status(400).json({ error: gError });
  }

  // Reparenting (#100): `parentId: <id>` adopts this task as a subtask of a
  // root target, `parentId: null` promotes it back to a root task. No-ops —
  // resending the stored parent id, or null on a task that is already a
  // root — pass untouched (the ADR-23/ADR-4 resend tolerance again), so the
  // validation matrix below judges only genuine moves and a pre-ban
  // recurring-under-sequential row stays editable.
  //
  // Queue position under a sequential target (ADR-18): heldBackSql and the
  // Tasks page child listing order by (created_at, id), and an adopted task
  // keeps its original created_at — a task older than the existing steps
  // enters the queue AHEAD of them (it may jump the queue). Deliberate:
  // adoption orders by creation time like everything else, one predicate and
  // no stored positions; explicit sibling ordering is a possible follow-up
  // if queue-jumping feels wrong in practice.
  let reparenting = false;
  if ("parentId" in body) {
    if (
      body.parentId != null &&
      (!Number.isInteger(body.parentId) || (body.parentId as number) < 1)
    ) {
      return res.status(400).json({
        error: "parentId must be a positive integer or null (null promotes to a root task)",
      });
    }
    if (body.parentId === id) {
      return res.status(400).json({ error: "a task cannot be its own parent" });
    }
    reparenting = body.parentId !== raw.parent_id;
  }
  if (reparenting && body.parentId != null) {
    const target = db
      .prepare(
        `SELECT parent_id AS parentId, subtask_order_mode AS orderMode,
                goal_id AS goalId, category_id AS categoryId, status
         FROM tasks WHERE id = ?`,
      )
      .get(body.parentId) as
      | {
          parentId: number | null;
          orderMode: string;
          goalId: number | null;
          categoryId: number;
          status: string;
        }
      | undefined;
    if (!target) return res.status(400).json({ error: "parent task not found" });
    // #104 item 1 — the last hole in the matrix. A DONE target is legal and
    // reopens below when an open child lands on it (#111, ADR-32); an ARCHIVED
    // one is rejected outright, see ARCHIVED_PARENT_ERROR.
    if (target.status === "archived") {
      return res.status(400).json({ error: ARCHIVED_PARENT_ERROR });
    }
    // One level deep, checked from BOTH directions (ADR-16): the target must
    // be a root, and the moved task must be childless — together these also
    // carry the acyclicity guarantee the v7 migration comment relies on
    // (ADR-24): a childless mover can never become anyone's ancestor.
    if (target.parentId != null) return res.status(400).json({ error: NESTED_BREAKDOWN_ERROR });
    if (db.prepare("SELECT 1 FROM tasks WHERE parent_id = ? LIMIT 1").get(id)) {
      return res.status(400).json({ error: PARENT_INTO_SUBTASK_ERROR });
    }
    // ADR-23 from the reparent direction (#66): adoption is a new transition
    // path that could CREATE the banned combination. Judged on the EFFECTIVE
    // recurrence — this PATCH may set or clear recurEveryDays in the same
    // body it moves the task with (clearing it makes the move legal).
    const recurAfter = "recurEveryDays" in body ? body.recurEveryDays : raw.recur_every_days;
    if (recurAfter != null && target.orderMode === "sequential") {
      return res.status(400).json({ error: RECURRING_SEQUENTIAL_ERROR });
    }
    // Single-create parity (#84): SENT divergent links are rejected. The
    // STORED links are overwritten below instead — they were never claimed
    // against the new parent, so the divergence gate does not apply to them.
    // goalId: null counts as "not specified" on the adoption path, like at
    // create — inheritance is unconditional either way.
    if (body.goalId != null && body.goalId !== target.goalId) {
      return res.status(400).json({ error: SUBTASK_GOAL_ERROR });
    }
    if ("categoryId" in body && body.categoryId !== target.categoryId) {
      return res.status(400).json({ error: SUBTASK_CATEGORY_ERROR });
    }
    // Adoption inheritance rides the ordinary field writes below: goal_id
    // follows the new parent UNCONDITIONALLY — goal counts, progress and the
    // goal-filtered draw key off each row's own goal_id, and a breakdown whose
    // children disagreed with their root about the goal would miscount (#84) —
    // while category_id follows only while the task is open, since done/
    // archived rows keep the category they were finished under (#44), exactly
    // like the parent-edit cascade and the v7 migration's adopt step.
    // Rewriting the body routes a wiped stored goal (goal-less parent) through
    // the deliberate-unlink machinery below (ADR-4, #76): impact resets to the
    // neutral 3, because the rating described leverage toward the goal
    // adoption just removed. Adoption that SETS a goal keeps the stored rating
    // — it now rates the inherited goal, and stays re-ratable.
    body.goalId = target.goalId;
    if (raw.status === "open") body.categoryId = target.categoryId;
  }

  // Completion goes through the gamification path.
  if (body.status === "done" && raw.status === "open") {
    const openChildren = db
      .prepare("SELECT COUNT(*) AS n FROM tasks WHERE parent_id = ? AND status = 'open'")
      .get(id) as { n: number };
    if (openChildren.n > 0) {
      return res.status(409).json({ error: "complete all subtasks first" });
    }
    // Manual-completion parity (#111, ADR-32): a parent with >= 1 non-
    // archived subtask (e.g. a legacy all-done-open row, or a reopened
    // parent completed by hand) earns the SAME symbolic zero-effort XP as
    // the auto-completion — its subtasks already paid out the effort XP, so
    // its own stored estimate must never mint a second helping. wasDrawn is
    // forced false with it: under rule 1 such a parent is never in the deck,
    // so a recent last_drawn_at can only be a pre-breakdown leftover. A
    // parent whose subtasks are ALL archived has zero non-archived children
    // and completes as an ordinary leaf.
    const zeroEffort = hasNonArchivedSubtask(id);
    // The drawn-card bonus is derived server-side, never from a client flag
    // (ADR-13): the persisted current draw survives reloads and long pauses;
    // the 6h last_drawn_at heuristic still covers a card completed shortly
    // after a redraw replaced it.
    const drawn = !zeroEffort && (getCurrentDrawTaskId() === id || wasRecentlyDrawn(raw));
    const outcome = db.transaction(() => {
      const result = completeTask(raw, drawn, zeroEffort ? { effortMinutes: 0 } : undefined);
      // Completing the last open subtask cascades upward (#111, ADR-32): the
      // parent auto-completes through completeTask in the same transaction.
      const parentCompletion =
        raw.parent_id != null ? maybeAutoCompleteParent(raw.parent_id) : null;
      return { result, parentCompletion };
    })();
    return res.json({
      task: getTask(id),
      ...outcome.result,
      // Surfaced so the client and MCP can announce the parent's XP,
      // achievements and level-up without a second request (#111).
      ...(outcome.parentCompletion
        ? { parentCompletion: { task: getTask(raw.parent_id!), ...outcome.parentCompletion } }
        : {}),
    });
  }

  // The one status transition with no honest write path (#122) — see
  // ARCHIVED_TO_DONE_ERROR. Judged AFTER the completion branch above, so a
  // legitimate open → done is untouched, and before the generic write below,
  // which is exactly what it must not reach. A no-op done → done resend still
  // passes there (the resend tolerance the ADR-4/ADR-23 gates also grant).
  if (body.status === "done" && raw.status === "archived") {
    return res.status(400).json({ error: ARCHIVED_TO_DONE_ERROR });
  }

  // Reopening: undo the latest completion so XP stays honest. A reopened
  // task starts fresh in the deck — leftover snooze/block state is cleared
  // (ADR-17), same as on completion.
  //
  // This early return also drops any OTHER field in the same body — notably a
  // parentId move (#104 item 4): the adoption guards above validated it, but
  // the generic write that would persist it sits below. Deliberate: reopen and
  // reparent are two different intents, and doing both atomically here would
  // duplicate the whole field-write path inside the reopen transaction for a
  // combination the UI never emits. The MCP update_task description tells
  // callers to reopen first, then reparent in a second call.
  if (body.status === "open" && raw.status === "done") {
    db.transaction(() => {
      undoLatestCompletion(id);
      db.prepare(
        "UPDATE tasks SET status = 'open', completed_at = NULL, deferred_until = NULL, blocked = 0 WHERE id = ?",
      ).run(id);
      // Reopen symmetry (#111, ADR-32): a reopened subtask is an open child
      // under a possibly-done parent — the state the lifecycle eliminates —
      // so the parent reopens the same way (its auto-completion undone).
      if (raw.parent_id != null) reopenDoneParent(raw.parent_id);
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
  // When the same PATCH also reparents, the stored parent's mode is moot: the
  // adoption guard above already judged the TARGET's mode against the
  // effective recurrence, and a simultaneous promote-to-root frees the task
  // from any queue a recurrence could deadlock.
  if (
    "recurEveryDays" in body &&
    body.recurEveryDays != null &&
    body.recurEveryDays !== raw.recur_every_days &&
    raw.parent_id != null &&
    !reparenting
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
  // A DELIBERATE unlink — the stored goal is removed by this PATCH. Distinct
  // from the edit form's no-op resend of goalId: null on an already goal-less
  // task, which must not disturb grandfathered ratings. Also drives the
  // subtask cascade below (#76).
  //
  // Open movers only on the ADOPTION path (#104 item 2). There the unlink is a
  // side effect of the move, not a rating decision the user expressed: the
  // rewrite above wipes the goal to follow the new root, and resetting impact
  // with it would edit a HISTORICAL record — the done row's rating is what the
  // stats buckets attribute the finished work by. That is the same open-only
  // line #44 draws for the category (right above), #76 draws for the unlink
  // cascade (below), and the v7 hoist draws for grandfathered grandchildren.
  // The done mover keeps its rating while its goal still follows, landing in
  // exactly the shape goal DELETION already grandfathers and ADR-4 tolerates:
  // a non-neutral rating with no goal, re-rateable only back to the neutral 3.
  // A DELIBERATE unlink (a sent goalId: null) still resets at any status — the
  // user is editing that row's rating on purpose, not moving it.
  const adopting = reparenting && body.parentId != null;
  const unlinking =
    "goalId" in body &&
    body.goalId == null &&
    raw.goal_id != null &&
    !(adopting && raw.status !== "open");
  if (goalAfter == null) {
    if (unlinking) {
      if ("impact" in body && body.impact !== 3) {
        // The adoption path words the same ADR-4 rule in its own terms —
        // there the unlink is a side effect of the move, not a sent goalId.
        return res.status(400).json({
          error:
            adopting
              ? "moving a task under a goal-less parent unlinks its goal and resets impact to " +
                "the neutral default 3 (ADR-4) — omit impact when reparenting into a goal-less " +
                "breakdown"
              : "unlinking the goal resets impact to the neutral default 3 (ADR-4) — omit " +
                "impact when unlinking, or set it together with a goalId to rate it",
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
    parentId: "parent_id",
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

  // Parent-lifecycle hooks on the generic write path (#111, ADR-32). The
  // parent judged is the row's CURRENT parent after this write — the adoption
  // target when the same PATCH reparents, the stored parent otherwise.
  // Reparenting AWAY is deliberately not a trigger: like legacy all-done-open
  // rows, an old parent left with only done children resolves on its next
  // subtask status change or via manual completion (zero-effort XP).
  const statusAfter = ("status" in body ? body.status : raw.status) as string;
  const parentAfter = (reparenting ? (body.parentId as number | null) : raw.parent_id) ?? null;

  const parentCompletion = db.transaction((): CompletionResult | null => {
    db.prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`).run(...params, id);
    let completion: CompletionResult | null = null;
    if (parentAfter != null) {
      if (statusAfter === "open" && (reparenting || raw.status === "archived")) {
        // An open child arrived under the parent — by adoption or by
        // un-archiving — so a done parent reopens, its auto-completion undone
        // (ADR-5). Adoption can no longer deliver one to an ARCHIVED root
        // (ARCHIVED_PARENT_ERROR, #104 item 1); un-archiving a child under a
        // still-archived root can, and deliberately leaves the root alone —
        // that root's own revival is the user's call, not a side effect.
        reopenDoneParent(parentAfter);
      } else if (statusAfter === "archived" && raw.status !== "archived") {
        // Archiving a subtask can finish the breakdown: with a done sibling
        // and no open ones left, the all-done predicate fires.
        completion = maybeAutoCompleteParent(parentAfter);
      }
    }
    // Subtasks follow their parent's goal: goal counts and the goal-filtered
    // draw key off each row's own goal_id, so a goal change must cascade to
    // the children (breakdown is one level deep — only roots can be split).
    if ("goalId" in body) {
      db.prepare("UPDATE tasks SET goal_id = ? WHERE parent_id = ?").run(body.goalId ?? null, id);
      // The server-owned unlink reset above cascades (#76): the subtasks'
      // ratings described leverage toward the goal that was just removed,
      // and they compete in the deck at impact²/effort like any other card.
      // Scoped to a deliberate unlink — a no-op resend of goalId: null (the
      // edit form emits one on every edit of a goal-less task) must not wipe
      // grandfathered ratings (goal deletion, goal-less breakdowns). Open
      // rows only: done/archived subtasks are historical records whose
      // impact feeds the stats buckets, mirroring the category cascade below.
      if (unlinking) {
        db.prepare("UPDATE tasks SET impact = 3 WHERE parent_id = ? AND status = 'open'").run(id);
      }
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
    return completion;
  })();

  const task = getTask(id)!;
  // Snoozing/blocking the current draw dismisses the card, so the persisted
  // pointer is cleared eagerly here, mirroring completeTask() — this is a
  // sideways mutation that must not wait for GET /api/draw/current's
  // lazy validation (ADR-13): a snooze wears off (and a block can be woken
  // from the Tasks page) without any GET in between, and the once-again
  // restorable pointer would resurrect a card the user explicitly sent away
  // (ADR-17). Reparenting the drawn card (#100) has the same wear-off shape:
  // moved into a held-back sequential position, the card would become
  // restorable again the moment the step in front completes — with no GET in
  // between — so the pointer is cleared eagerly too. The other reparent case
  // (a task adopted UNDER the drawn card, turning it into a container)
  // cannot be seen here — that PATCH runs on the child's id — and stays with
  // the lazy validation the subtask-creation path already relies on:
  // isRestorable rejects hasOpenChildren on the next GET /api/draw/current,
  // which the client fires right after every task mutation (the tasks hooks
  // invalidate the current-draw query). Not gated on the card being the
  // current draw: clearCurrentDraw(id) already no-ops unless the pointer IS
  // this task, so it needs no guard of its own.
  if (
    ("deferredUntil" in body || "blocked" in body || "parentId" in body) &&
    !isRestorable(task as unknown as RestorableTask, getSetting("max_draw_effort", 30), new Date())
  ) {
    clearCurrentDraw(id);
  }
  res.json({
    task,
    ...(parentCompletion
      ? { parentCompletion: { task: getTask(parentAfter!), ...parentCompletion } }
      : {}),
  });
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

// Regenerate (#113): the ONLY path that replaces a cached artwork. Generate-
// then-replace — a failed generation keeps the old row; concurrent requests
// coalesce onto one in-flight generation (cardArtService). Same degraded
// contract as the GET: 503 ai_not_configured, swallowed silently client-side.
tasksRouter.post("/:id/card-art/regenerate", async (req, res) => {
  try {
    res.json(await regenerateCardArt(Number(req.params.id)));
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
  const row = db.prepare("SELECT parent_id AS parentId FROM tasks WHERE id = ?").get(id) as
    | { parentId: number | null }
    | undefined;
  if (!row) return res.status(404).json({ error: "task not found" });
  // Deleting a subtask can finish the breakdown (#111, ADR-32): "this
  // remaining step is irrelevant" is a natural way to close one out, so the
  // lifecycle hook runs here like on every status-changing write, in the
  // same transaction. Deleting a parent's ONLY subtask instead leaves zero
  // children — the all-done predicate needs >= 1 done one — and the parent
  // revives as a leaf (PR #102), not as done. The reopen direction needs no
  // hook: a delete only ever removes children, never adds an open one.
  const parentCompletion = db.transaction((): CompletionResult | null => {
    db.prepare("DELETE FROM tasks WHERE id = ?").run(id);
    return row.parentId != null ? maybeAutoCompleteParent(row.parentId) : null;
  })();
  // A deleted card leaves the deck — whether it was deleted directly or
  // cascade-deleted with its parent. Cleared on row absence, not id match:
  // a freed id (no AUTOINCREMENT) could be re-bound to the next captured
  // task before the lazy restore validation ever runs.
  clearDanglingDraw();
  res.json({
    ok: true,
    // Same cascade surface as the completion paths (#111): XP, achievements
    // and level-up without a second request. The client's delete mutation
    // invalidates gamification/stats/tasks anyway; MCP flows read it.
    ...(parentCompletion
      ? { parentCompletion: { task: getTask(row.parentId!), ...parentCompletion } }
      : {}),
  });
});
