import type { Task } from "../api/types";

/**
 * Above this many candidates the link-existing picker shows a search box
 * (#87) — below it, scanning a short list beats typing.
 */
export const LINK_SEARCH_THRESHOLD = 10;

/**
 * Tasks the GoalCard's link-existing picker may offer (#87): open, goal-less
 * ROOT tasks only. Subtasks are never offered — they follow their parent's
 * goal (the PATCH cascade, #76), so linking one directly would let it drift
 * from its siblings. GET /api/tasks already returns only roots, but the
 * filter re-checks parentId so the invariant holds regardless of the source.
 */
export function linkableTasks(tasks: Task[]): Task[] {
  return tasks.filter((t) => t.status === "open" && t.goalId == null && t.parentId == null);
}

/** Case-insensitive substring match on the title; a blank query keeps all. */
export function filterByTitle(tasks: Task[], query: string): Task[] {
  const q = query.trim().toLowerCase();
  if (!q) return tasks;
  return tasks.filter((t) => t.title.toLowerCase().includes(q));
}
