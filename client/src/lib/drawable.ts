import type { Task } from "../api/types";

export type DrawGroup = "ready" | "needs-estimate" | "too-big" | "container" | "snoozed";

/**
 * Derived snooze state (ADR-16): blocked, or deferredUntil in the future.
 * Never read from a stored flag — an expired snooze ends with no write.
 */
export function isSnoozed(
  task: Pick<Task, "blocked" | "deferredUntil">,
  now: Date = new Date(),
): boolean {
  return task.blocked || (task.deferredUntil != null && new Date(task.deferredUntil) > now);
}

/**
 * Mirrors the server's pool predicate (`drawService.ts`), pinned by the shared
 * vectors in `shared/drawableVectors.ts`. Precedence:
 * container → snoozed → needs-estimate → too-big → ready.
 */
export function classifyTask(task: Task, maxDrawEffort: number, now: Date = new Date()): DrawGroup {
  if (task.hasOpenChildren) return "container";
  if (isSnoozed(task, now)) return "snoozed";
  if (task.effortMinutes == null) return "needs-estimate";
  if (task.effortMinutes > maxDrawEffort) return "too-big";
  return "ready";
}

/** Flatten roots + subtasks into a single list of open tasks. */
export function flattenOpen(tasks: Task[]): Task[] {
  const out: Task[] = [];
  for (const t of tasks) {
    if (t.status === "open") out.push(t);
    for (const s of t.subtasks ?? []) {
      if (s.status === "open") out.push(s);
    }
  }
  return out;
}

export function isDueSoon(dueDate: string | null): "overdue" | "today" | "soon" | null {
  if (!dueDate) return null;
  const today = new Date().toISOString().slice(0, 10);
  if (dueDate < today) return "overdue";
  if (dueDate === today) return "today";
  const in3 = new Date();
  in3.setDate(in3.getDate() + 3);
  if (dueDate <= in3.toISOString().slice(0, 10)) return "soon";
  return null;
}
