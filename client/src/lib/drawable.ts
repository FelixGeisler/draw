import type { Task } from "../api/types";

export type DrawGroup =
  | "ready"
  | "needs-estimate"
  | "too-big"
  | "container"
  | "snoozed"
  | "queued"
  | "scheduled";

/**
 * Derived snooze state (ADR-17): blocked, or deferredUntil in the future.
 * Never read from a stored flag — an expired snooze ends with no write.
 */
export function isSnoozed(
  task: Pick<Task, "blocked" | "deferredUntil">,
  now: Date = new Date(),
): boolean {
  return task.blocked || (task.deferredUntil != null && new Date(task.deferredUntil) > now);
}

/**
 * Availability-window predicate (#33, ADR-20) — mirrors the server's
 * `isWithinWindow` in drawService.ts, pinned by the shared WINDOW_VECTORS.
 * True when the task has no window, or `now` falls on one of its weekdays
 * inside [start, end) — start inclusive, end exclusive, "24:00" meaning
 * end-of-day. Deliberately LOCAL wall clock (getDay/getHours, never getUTC*).
 */
export function isWithinWindow(
  days: number[] | null | undefined,
  start: string | null | undefined,
  end: string | null | undefined,
  now: Date,
): boolean {
  if (days == null || start == null || end == null) return true;
  if (!days.includes(now.getDay())) return false;
  const toMinutes = (hhmm: string) => {
    const [h, m] = hhmm.split(":").map(Number);
    return h * 60 + m; // "24:00" → 1440
  };
  const minutes = now.getHours() * 60 + now.getMinutes();
  return minutes >= toMinutes(start) && minutes < toMinutes(end);
}

/**
 * Mirrors the server's pool predicate (`drawService.ts`), pinned by the shared
 * vectors in `shared/drawableVectors.ts`. Precedence:
 * container → snoozed → queued → scheduled → needs-estimate → too-big → ready.
 * Snoozed outranks queued: an explicit user action (snooze/block) is more
 * informative than the derived queue position, and it keeps the Wake
 * affordance visible — on wake the task simply re-classifies as queued.
 * Queued outranks scheduled: a card behind a sequential sibling is out of the
 * deck regardless of its window, and the queue explains why better.
 */
export function classifyTask(task: Task, maxDrawEffort: number, now: Date = new Date()): DrawGroup {
  // Any NON-ARCHIVED child makes a container (#111, ADR-32): while a
  // breakdown exists — even all-done — the parent's own estimate is inert.
  // hasOpenChildren stays as the fallback for payloads without the field.
  if (task.hasOpenChildren || task.hasNonArchivedChildren) return "container";
  if (isSnoozed(task, now)) return "snoozed";
  if (task.heldBack) return "queued";
  if (!isWithinWindow(task.windowDays, task.windowStart, task.windowEnd, now)) return "scheduled";
  if (task.effortMinutes == null) return "needs-estimate";
  if (task.effortMinutes > maxDrawEffort) return "too-big";
  return "ready";
}

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
// Chips render Mon-first even though storage is getDay() numbers (0 = Sun).
const DISPLAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

/** Compact window chip label, e.g. "Mon–Fri 08:00–12:00" or "daily 06:00–09:00". */
export function formatWindow(days: number[], start: string, end: string): string {
  const range = `${start}–${end}`;
  const positions = DISPLAY_ORDER.map((d, i) => (days.includes(d) ? i : -1)).filter((i) => i >= 0);
  if (positions.length === 7) return `daily ${range}`;
  const parts: string[] = [];
  for (let s = 0; s < positions.length; ) {
    let e = s;
    while (e + 1 < positions.length && positions[e + 1] === positions[e] + 1) e++;
    const from = DAY_LABELS[DISPLAY_ORDER[positions[s]]];
    const to = DAY_LABELS[DISPLAY_ORDER[positions[e]]];
    parts.push(s === e ? from : e - s === 1 ? `${from}, ${to}` : `${from}–${to}`);
    s = e + 1;
  }
  return `${parts.join(", ")} ${range}`;
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

export interface SiblingCluster {
  parent: Task;
  items: Task[];
}

/**
 * Capture-list ergonomics (#30): split a section's tasks into flat top-level
 * rows and per-parent sibling clusters, so a 40-leaf import (#29) renders as
 * one collapsible header instead of 40 flat rows. Trees are two levels deep
 * everywhere (ADR-16/24), so the parent lookup is over roots only. Singleton
 * clusters stay clustered: a leaf title like "Ex 40 (part 2)" is meaningless
 * without its umbrella's name, and the group's location must not jump when
 * the second-to-last sibling completes. A leaf whose parent is missing from
 * the roots list falls back to a flat row rather than vanishing.
 */
export function groupSiblings(
  items: Task[],
  roots: Task[],
): { flat: Task[]; clusters: SiblingCluster[] } {
  const rootById = new Map(roots.map((r) => [r.id, r]));
  const flat: Task[] = [];
  const clusters: SiblingCluster[] = [];
  const byParent = new Map<number, SiblingCluster>();
  for (const t of items) {
    const parent = t.parentId != null ? rootById.get(t.parentId) : undefined;
    if (!parent) {
      flat.push(t);
      continue;
    }
    let cluster = byParent.get(parent.id);
    if (!cluster) {
      cluster = { parent, items: [] };
      byParent.set(parent.id, cluster);
      clusters.push(cluster);
    }
    cluster.items.push(t);
  }
  return { flat, clusters };
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
