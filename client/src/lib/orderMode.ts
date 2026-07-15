import type { Task } from "../api/types";

/**
 * Seed for the AI breakdown's "Do in order" toggle (#67). Accepting an AI
 * breakdown always sends an explicit orderMode, so seeding from the model's
 * `orderMatters` judgment alone could silently flip an already-sequential
 * parent back to parallel on a re-breakdown (or an explicitly-parallel one
 * to sequential). A parent that was broken down before therefore keeps its
 * persisted mode; the model's judgment only pre-sets parents without an
 * existing mode. The user has the last word via the checkbox either way.
 */
export function seedInOrder(
  orderMatters: boolean,
  existingOrderMode?: Task["subtaskOrderMode"],
): boolean {
  return existingOrderMode != null ? existingOrderMode === "sequential" : orderMatters;
}

/**
 * Recurring × sequential guard (#66, ADR-23): a recurring step never closes
 * (completing it advances its due date, ADR-6), so it would hold every later
 * sibling of a sequential breakdown back forever — the API rejects the
 * transition. True when switching this parent to 'sequential' would be such
 * a transition: it is not sequential yet AND a listed subtask carries a
 * recurrence. An already-sequential parent is never locked — resending its
 * mode is a no-op the API accepts, and flipping AWAY from sequential is the
 * repair path for a pre-ban database.
 */
export function sequentialLockedByRecurrence(
  subtasks: Pick<Task, "recurEveryDays">[] | undefined,
  orderMode: Task["subtaskOrderMode"],
): boolean {
  return orderMode !== "sequential" && (subtasks ?? []).some((s) => s.recurEveryDays != null);
}
