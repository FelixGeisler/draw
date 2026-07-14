import type { Task } from "../api/types";

export type DrawGroup = "ready" | "needs-estimate" | "too-big" | "container";

export function classifyTask(task: Task, maxDrawEffort: number): DrawGroup {
  if (task.hasOpenChildren) return "container";
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
