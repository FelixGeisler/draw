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
  /**
   * Recurrence interval in days (ADR-6). On a recurring task `dueDate` is
   * the NEXT OCCURRENCE (#205): the card classifies as "scheduled" and
   * leaves the deck until that day, and completing it schedules the one
   * after. A non-recurring task's due date never keeps it out of the deck.
   */
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
   * 'sequential' parent exposes only its first open subtask (in sibling order,
   * (sort_order, id) since #157/ADR-43 — drag-reorderable) to the draw pool.
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
   * Derived at query time like hasOpenChildren (0/1): ANY non-archived child
   * — done ones included — keeps a parent classified as a container and out
   * of the deck (#111, ADR-32); only archived-out or moved-away children
   * revive it as a leaf. Optional: the draw payloads carry it as a constant
   * 0 (dealt cards are leaves by construction).
   */
  hasNonArchivedChildren?: number;
  /**
   * Derived at query time like hasOpenChildren (0/1): an older open sibling
   * under a 'sequential' parent holds this task out of the deck until the
   * earlier steps close. Never stored — completing the step in front frees
   * the next one with no write.
   */
  heldBack: number;
  /**
   * Derived at query time (never stored, #111/ADR-32): while ANY non-archived
   * subtask exists, the sum of OPEN subtasks' estimates — null when none are
   * open (all-done breakdown) or none estimated — and NEVER the task's own
   * stored effortMinutes. Only a task with zero non-archived children (a true
   * leaf, or a parent revived by its children all archiving or moving away)
   * reports its own effortMinutes here. Absent on task shapes from the
   * draw/timer endpoints, which only ever carry drawable leaves.
   */
  remainingEffortMinutes?: number | null;
  /**
   * Minutes fought on the card (#115), derived at query time: whole minutes
   * over the task's CLOSED time entries. Present only on the draw payloads
   * (POST /api/draw, GET /api/draw/current). The UI stopped rendering it
   * when the TCG frame's DEF stat died (#123); the payload field stays for
   * API/MCP consumers.
   */
  trackedMinutes?: number;
  subtasks?: Task[];
}

export interface CompletionResponse {
  task: Task;
  xpAwarded?: number;
  /**
   * Why the XP is higher than plain (#57): "warmup" — the dealt warm-up card
   * finished inside its bonus window (×1.25); "momentum" — a non-drawn task
   * completed within 30 min of a warm-up completion (×1.25). Null when no
   * bonus beyond the ordinary drawn ×1.5 applied.
   */
  bonus?: "warmup" | "momentum" | null;
  newAchievements?: string[];
  recurring?: boolean;
  /**
   * Present when completing (or archiving) the last open subtask
   * auto-completed its parent (#111, ADR-32): the parent's own completion
   * result — a symbolic 1 XP (zero-effort floor, the subtasks already earned
   * the effort XP), plus any achievements/level-up it triggered.
   */
  parentCompletion?: Omit<CompletionResponse, "parentCompletion">;
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
  status: "active" | "achieved" | "missed" | "dropped";
  createdAt: string;
  /**
   * Goal resolution (#145, ADR-38): when the goal left 'active' — an event
   * fact maintained server-side only (set on resolve, kept across
   * corrections, cleared on reactivation). NULL on goals resolved before
   * migration v12: render no date rather than a guess.
   */
  resolvedAt: string | null;
  taskCount: number;
  doneCount: number;
  materialCount: number;
  /**
   * Feasibility inputs (#60), derived at query time (never stored): sum of
   * estimates over the goal's open leaf tasks (a broken-down parent counts
   * via its open subtasks, not its own estimate on top — null when no open
   * leaf is estimated), and minutes tracked on the goal's tasks in the last
   * 14 days (running entry counted up to now). lib/feasibility.ts turns
   * these into the on-track/tight/infeasible chip.
   */
  remainingOpenEffortMinutes: number | null;
  /**
   * The boss bar's max HP (#229): the same leaf rule over open AND done
   * leaves, so remaining <= total always holds. NULL when no leaf carries an
   * estimate — no bar without numbers to mean anything.
   */
  totalEffortMinutes: number | null;
  trackedMinutes14d: number;
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
