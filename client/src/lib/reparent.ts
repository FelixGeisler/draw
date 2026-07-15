import type { Task } from "../api/types";

/**
 * Reparent eligibility (#100) — the client mirror of the PATCH parentId
 * validation matrix in server/src/routes/tasks.ts, extracted as pure rules so
 * the "Move under…" picker and the drag-and-drop follow-up (#101) share one
 * source. Every rule answers "can task X move under task Y / to root, and if
 * not, why" with the reason to show; the server's 400s stay the backstop for
 * anything this mirror cannot see (e.g. archived children, which the list
 * payload hides).
 */

/** What the rules read off the moved task. */
export type ReparentSource = Pick<Task, "id" | "parentId" | "recurEveryDays" | "hasOpenChildren"> & {
  subtasks?: Pick<Task, "id">[];
};

/** What the rules read off a candidate parent. */
export type ReparentTargetTask = Pick<Task, "id" | "parentId" | "status" | "subtaskOrderMode">;

export const OWN_PARENT_REASON = "a task cannot be its own parent";
export const TARGET_IS_SUBTASK_REASON =
  "breakdowns are one level deep (ADR-16): this target is itself a subtask";
export const HAS_SUBTASKS_REASON =
  "a task with subtasks cannot become a subtask itself (ADR-16)";
export const ALREADY_UNDER_TARGET_REASON = "already a subtask of this target";
export const RECURRING_SEQUENTIAL_REASON =
  "recurring tasks cannot join a “do in order” breakdown (ADR-23): a recurring step " +
  "never closes and would gate the steps behind it forever";
export const ALREADY_ROOT_REASON = "already a top-level task";

/** Why `task` cannot move under `target` — null when the move is eligible. */
export function moveUnderBlockReason(
  task: ReparentSource,
  target: ReparentTargetTask,
): string | null {
  if (target.id === task.id) return OWN_PARENT_REASON;
  if (target.parentId != null) return TARGET_IS_SUBTASK_REASON;
  // The list payload omits archived children, so a fully-archived breakdown
  // slips past this mirror — the server rejects it (any-status check) and
  // the row surfaces that 400 as the backstop.
  if ((task.subtasks?.length ?? 0) > 0 || task.hasOpenChildren) return HAS_SUBTASKS_REASON;
  if (target.id === task.parentId) return ALREADY_UNDER_TARGET_REASON;
  if (task.recurEveryDays != null && target.subtaskOrderMode === "sequential") {
    return RECURRING_SEQUENTIAL_REASON;
  }
  return null;
}

/** Why `task` cannot be promoted to a top-level task — null when it can. */
export function promoteBlockReason(task: Pick<Task, "parentId">): string | null {
  return task.parentId == null ? ALREADY_ROOT_REASON : null;
}

/**
 * Whether a task is offered as a "Move under…" destination at all. Done and
 * archived tasks are omitted outright (not listed disabled) — adopting new
 * work under finished work is never what reorganizing means. Shared by the
 * picker's candidate list and the DnD routing (#101, inert rows there), so
 * the two inputs cannot silently diverge on what is offered vs merely
 * blocked-with-reason.
 */
export function isOfferableTarget(target: Pick<Task, "status">): boolean {
  return target.status === "open";
}

/**
 * Whether a task's row offers the "Move under…" gesture at all: only root
 * tasks do — a subtask's single reorganize gesture is promotion, because
 * breakdowns are one level deep (ADR-16) and moving between parents is not a
 * thing. Shared by TaskRow's button gate and the DnD routing (#101).
 */
export function offersMoveUnder(task: Pick<Task, "parentId">): boolean {
  return task.parentId == null;
}

export interface ReparentTarget {
  target: Task;
  /** null = pickable; otherwise shown as the disabled option's reason. */
  blockReason: string | null;
}

/**
 * The "Move under…" picker's option list: every offerable (open) root task
 * except the moved one, each carrying its block reason (ADR-23 targets stay
 * listed but disabled, so the rule is visible instead of the target silently
 * missing).
 */
export function reparentTargets(task: ReparentSource, roots: Task[]): ReparentTarget[] {
  return roots
    .filter((r) => r.id !== task.id && r.parentId == null && isOfferableTarget(r))
    .map((target) => ({ target, blockReason: moveUnderBlockReason(task, target) }));
}
