import type { Category, Goal, Task } from "../api/types";
import { pillInk } from "../lib/cardVisuals";
import {
  formatWindow,
  isAwaitingNextOccurrence,
  isDueSoon,
  isSnoozed,
  isWithinWindow,
} from "../lib/drawable";
import { displayEffort } from "../lib/effort";

/** Compact local wake time for the 💤 chip, e.g. "2026-07-15 18:00". */
function formatWake(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function ImpactStars({ value }: { value: number }) {
  return (
    <span title={`Impact ${value}/5`} style={{ color: "#ffb64f", fontSize: 13 }}>
      {"★".repeat(value)}
      <span style={{ opacity: 0.25 }}>{"★".repeat(5 - value)}</span>
    </span>
  );
}

/** The category-colored pill — shared by the drawn card, the trophy pile's
 *  lifted details and the focus overlay, so "category" reads identically
 *  everywhere. Background is the raw category color; the ink is the computed
 *  WCAG-contrast choice (lib/cardVisuals.pillInk — the piece of #120 that
 *  survived the #123 redesign), never an eyeballed one. */
export function CategoryPill({ category, className }: { category: Category; className?: string }) {
  return (
    <span
      className={`category-pill ${className ?? ""}`}
      style={{ background: category.color, color: pillInk(category.color) }}
    >
      {category.name}
    </span>
  );
}

export function TaskBadges({
  task,
  showStars,
  goals,
}: {
  task: Task;
  showStars?: boolean;
  /**
   * Goal chip (#88): rendered only when the caller supplies the goals list —
   * the Tasks page rows let you edit the goal link (#17), so they show which
   * goal that is. Callers without the list (the drawn card) stay as-is.
   */
  goals?: Goal[];
}) {
  const due = isDueSoon(task.dueDate);
  // Between occurrences (#205) the due date is not a deadline to hurry
  // toward but the day the card comes back, so the chip says "next" in the
  // warn color the availability window uses for "out of the deck, returns on
  // its own" — never the red of a looming deadline the user cannot act on.
  const awaitingOccurrence = task.status === "open" && isAwaitingNextOccurrence(task);
  const effort = displayEffort(task);
  const goal = task.goalId != null ? goals?.find((g) => g.id === task.goalId) : undefined;
  return (
    <span style={{ display: "inline-flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
      {effort != null && <span className="chip">{effort} min</span>}
      {task.dueDate && (
        <span
          className="chip"
          title={
            awaitingOccurrence
              ? `Waiting for its next occurrence — out of the deck until ${task.dueDate}`
              : undefined
          }
          style={
            awaitingOccurrence
              ? { borderColor: "var(--warn)", color: "var(--warn)" }
              : due === "overdue" || due === "today"
                ? { borderColor: "var(--danger)", color: "var(--danger)" }
                : due === "soon"
                  ? { borderColor: "var(--warn)", color: "var(--warn)" }
                  : undefined
          }
        >
          {awaitingOccurrence ? "next " : due === "overdue" ? "overdue " : "due "}
          {task.dueDate}
        </span>
      )}
      {task.recurEveryDays != null && (
        <span className="chip" title={`Repeats every ${task.recurEveryDays} days`}>
          ↻ {task.recurEveryDays}d
        </span>
      )}
      {/* Derived, never a stored flag (ADR-17): 💤 only while the wake time
          is still ahead — an expired snooze simply stops showing. */}
      {task.deferredUntil != null && new Date(task.deferredUntil) > new Date() && (
        <span className="chip" title={`Snoozed until ${formatWake(task.deferredUntil)}`}>
          💤 until {formatWake(task.deferredUntil)}
        </span>
      )}
      {task.blocked && (
        <span className="chip" title="Blocked — out of the deck until woken">
          ⛔ blocked
        </span>
      )}
      {/* Sequential hold-back (#23): derived queue position, hidden while the
          task is snoozed (classifyTask precedence — snoozed wins) and on done
          rows — a step completed out of order is not "in line" (#67). */}
      {task.status === "open" && Boolean(task.heldBack) && !isSnoozed(task) && (
        <span className="chip" title="In line — this breakdown is done in order; finish the steps in front first">
          ⏳ queued
        </span>
      )}
      {/* Availability window (#33): warn-colored while currently outside it —
          the card is out of the deck and returns on its own. */}
      {task.windowDays != null && task.windowStart != null && task.windowEnd != null && (
        <span
          className="chip"
          style={
            isWithinWindow(task.windowDays, task.windowStart, task.windowEnd, new Date())
              ? undefined
              : { borderColor: "var(--warn)", color: "var(--warn)" }
          }
          title={
            isWithinWindow(task.windowDays, task.windowStart, task.windowEnd, new Date())
              ? "Availability window — currently open"
              : "Outside its availability window — out of the deck until it opens again"
          }
        >
          🕒 {formatWindow(task.windowDays, task.windowStart, task.windowEnd)}
        </span>
      )}
      {goal && (
        // chip-clip (#213): the goal title is unbounded user text — the one
        // badge whose width the platform does not decide — and unclamped it
        // squeezed the task title to min-content. The tooltip carries it whole.
        <span
          className="chip chip-clip"
          style={{ color: "var(--text-dim)" }}
          title={`Linked to goal: ${goal.title}`}
        >
          🎯 {goal.title}
        </span>
      )}
      {(showStars ?? task.goalId != null) && <ImpactStars value={task.impact} />}
    </span>
  );
}
