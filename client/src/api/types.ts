export interface Category {
  id: number;
  name: string;
  color: string;
  isDefault: number;
}

export interface Health {
  ok: boolean;
  time: string;
}

export interface Task {
  id: number;
  title: string;
  description: string | null;
  categoryId: number;
  goalId: number | null;
  parentId: number | null;
  impact: number;
  effortMinutes: number | null;
  dueDate: string | null;
  recurEveryDays: number | null;
  status: "open" | "done" | "archived";
  createdAt: string;
  completedAt: string | null;
  lastDrawnAt: string | null;
  hasOpenChildren: number;
  /**
   * Derived at query time (never stored): sum of OPEN subtasks' estimates for a
   * broken-down task, the task's own effortMinutes otherwise. Null when the open
   * subtasks are all unestimated. Absent on task shapes from the draw/timer
   * endpoints, which only ever carry drawable leaves.
   */
  remainingEffortMinutes?: number | null;
  subtasks?: Task[];
}

export interface CompletionResponse {
  task: Task;
  xpAwarded?: number;
  newAchievements?: string[];
  recurring?: boolean;
}

export type Settings = Record<string, string>;

export interface NewTask {
  title: string;
  description?: string;
  categoryId: number;
  goalId?: number | null;
  parentId?: number | null;
  impact?: number;
  effortMinutes?: number | null;
  dueDate?: string | null;
  recurEveryDays?: number | null;
}

export interface NewSubtask {
  title: string;
  /** Optional provenance line, e.g. "Exercise 7 · 8 pts · ~45 min · exam.pdf" (#28/#29). */
  description?: string;
  effortMinutes?: number | null;
  impact?: number;
}

export interface Goal {
  id: number;
  title: string;
  outcome: string | null;
  targetDate: string | null;
  status: "active" | "achieved" | "dropped";
  createdAt: string;
  taskCount: number;
  doneCount: number;
  materialCount: number;
}

export interface Material {
  id: number;
  goalId: number;
  kind: "file" | "note";
  filename: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  noteText: string | null;
  createdAt: string;
}
