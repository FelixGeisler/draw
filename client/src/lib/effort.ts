import type { Task } from "../api/types";

/**
 * Effort to display for a task. The list endpoint derives
 * remainingEffortMinutes (sum of open subtasks' estimates for broken-down
 * tasks); task shapes without the field (drawn card, timer bar — always
 * drawable leaves) fall back to the stored own estimate. Present-but-null
 * means "open subtasks, none estimated": return null so callers hide the
 * chip instead of showing the parent's stale own estimate.
 */
export function displayEffort(
  task: Pick<Task, "effortMinutes" | "remainingEffortMinutes">,
): number | null {
  return task.remainingEffortMinutes !== undefined
    ? task.remainingEffortMinutes
    : task.effortMinutes;
}
