// #243 command palette — pure selection/navigation core. The client unit
// suite has no DOM, so everything keyboard-decision-shaped lives here as
// plain functions; the CommandPalette component only wires events to them.
// The colocated spec (paletteNav.test.ts) is the contract.

/** The fixed actions shown for an empty query (and matched by name otherwise). */
export type PaletteAction =
  | "draw" // → navigate to /, focus the deck — NEVER deals (a draw is a commitment)
  | "capture" // → navigate to /tasks, focus the quick-capture title input
  | "toggle-timer" // → resolved via timerToggleCommand at execution time
  | "goto-goals"
  | "goto-stats"
  | "goto-settings";

/** One selectable row in the flattened result list (groups are display-only). */
export type PaletteEntry =
  | { kind: "action"; action: PaletteAction }
  | { kind: "task"; id: number; status: "open" | "done" }
  | { kind: "goal"; id: number };

/** What executing an entry (or a global key) should do — the component interprets. */
export type PaletteCommand =
  | { type: "none" }
  | { type: "navigate"; to: string }
  | { type: "goto-draw" }
  | { type: "capture" }
  | { type: "toggle-timer" }
  | { type: "stop-timer" }
  | { type: "start-task-timer"; taskId: number }
  | { type: "open-task"; taskId: number; showDone: boolean }
  | { type: "open-goal"; goalId: number };

/**
 * ArrowUp/ArrowDown selection over a flat list of `count` entries.
 * Wraps at both ends; -1 (or any out-of-range index, e.g. after the result
 * list shrank under the cursor) means "nothing selected" and enters the list
 * at the near end. count <= 0 always yields -1.
 */
export function moveSelection(count: number, index: number, delta: -1 | 1): number {
  if (count <= 0) return -1;
  // Unselected or stale (the list shrank under the cursor): enter at the end
  // nearest the pressed key — ArrowDown from nothing means "the first one".
  if (index < 0 || index >= count) return delta === 1 ? 0 : count - 1;
  return (index + delta + count) % count;
}

/**
 * Enter / Ctrl+Enter on the selected entry.
 * - task + Ctrl → start its timer (open tasks only: the server 409s a done
 *   task, so Ctrl+Enter on a done task falls back to plain Enter = open it)
 * - task → open on /tasks; showDone mirrors the task being done, so the page
 *   can enable its "show done" toggle before scrolling to the row
 * - goal → open on /goals (Ctrl is ignored)
 * - action → its command (Ctrl is ignored)
 */
export function commandForEntry(entry: PaletteEntry, withCtrl: boolean): PaletteCommand {
  switch (entry.kind) {
    case "task":
      if (withCtrl && entry.status === "open") {
        return { type: "start-task-timer", taskId: entry.id };
      }
      return { type: "open-task", taskId: entry.id, showDone: entry.status === "done" };
    case "goal":
      return { type: "open-goal", goalId: entry.id };
    case "action":
      switch (entry.action) {
        case "draw":
          return { type: "goto-draw" };
        case "capture":
          return { type: "capture" };
        case "toggle-timer":
          return { type: "toggle-timer" };
        case "goto-goals":
          return { type: "navigate", to: "/goals" };
        case "goto-stats":
          return { type: "navigate", to: "/stats" };
        case "goto-settings":
          return { type: "navigate", to: "/settings" };
      }
  }
}

/**
 * The space key / "Start/stop timer" action, resolved against the two
 * server-persisted facts: a running timer wins (stop it); otherwise a
 * persisted current draw starts its timer; otherwise nothing — a stray
 * space must never gamble or error.
 */
export function timerToggleCommand(
  runningTaskId: number | null,
  currentDrawTaskId: number | null,
): PaletteCommand {
  if (runningTaskId != null) return { type: "stop-timer" };
  if (currentDrawTaskId != null) return { type: "start-task-timer", taskId: currentDrawTaskId };
  return { type: "none" };
}
