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

/**
 * One row of GET /api/stats/estimation-bias (#55): a category's all-history
 * tracked/estimated ratio over its qualifying completed tasks. The server
 * returns every category with data; minimum-sample thresholds are applied
 * client-side (lib/estimationCoach.ts).
 */
export interface CategoryBias {
  categoryId: number;
  name: string;
  color: string;
  taskCount: number;
  ratio: number;
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
  /**
   * Snooze/block (ADR-17). An expired deferredUntil is retained as the wake
   * timestamp — "snoozed" is always derived (deferredUntil in the future or
   * blocked), never read from a stored flag.
   */
  deferredUntil: string | null;
  blocked: boolean;
  /**
   * Sequential subtask mode (#23, ADR-18). Only meaningful on parents: a
   * 'sequential' parent exposes only its first open subtask (creation order)
   * to the draw pool.
   */
  subtaskOrderMode: "parallel" | "sequential";
  /**
   * Availability window (#33, ADR-20): weekdays (JS getDay convention,
   * 0 = Sunday) plus a daily [windowStart, windowEnd) range as "HH:MM"
   * ("24:00" allowed as end). All three set or all three null. Evaluated on
   * the LOCAL wall clock — outside the window the task classifies as
   * "scheduled" and leaves the draw pool; it returns on its own.
   */
  windowDays: number[] | null;
  windowStart: string | null;
  windowEnd: string | null;
  hasOpenChildren: number;
  /**
   * Derived at query time like hasOpenChildren (0/1): an older open sibling
   * under a 'sequential' parent holds this task out of the deck until the
   * earlier steps close. Never stored — completing the step in front frees
   * the next one with no write.
   */
  heldBack: number;
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
  /** Availability window (#33): all three together, or all null/absent. */
  windowDays?: number[] | null;
  windowStart?: string | null;
  windowEnd?: string | null;
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
