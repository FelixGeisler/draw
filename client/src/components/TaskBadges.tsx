import type { Goal, Task } from "../api/types";
import { formatWindow, isDueSoon, isSnoozed, isWithinWindow } from "../lib/drawable";
import { displayEffort } from "../lib/effort";

/** Compact local wake time for the 💤 chip, e.g. "2026-07-15 18:00". */
function formatWake(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function ImpactStars({ value, size }: { value: number; size?: number }) {
  // size: the trophy mini-frames (#115) shrink the row to fit a 90px card;
  // everywhere else keeps the 13px default.
  return (
    <span title={`Impact ${value}/5`} style={{ color: "#ffb64f", fontSize: size ?? 13 }}>
      {"★".repeat(value)}
      <span style={{ opacity: 0.25 }}>{"★".repeat(5 - value)}</span>
    </span>
  );
}

export function TaskBadges({
  task,
  showStars,
  showEffort,
  goals,
}: {
  task: Task;
  showStars?: boolean;
  /**
   * Effort chip toggle (#115): the drawn card's TCG frame renders the
   * estimate as its ATK stat, so it suppresses the "N min" chip — one datum,
   * one place. Every other caller keeps the chip (default true).
   */
  showEffort?: boolean;
  /**
   * Goal chip (#88): rendered only when the caller supplies the goals list —
   * the Tasks page rows let you edit the goal link (#17), so they show which
   * goal that is. Callers without the list (drawn card, Capture) stay as-is.
   */
  goals?: Goal[];
}) {
  const due = isDueSoon(task.dueDate);
  const effort = displayEffort(task);
  const goal = task.goalId != null ? goals?.find((g) => g.id === task.goalId) : undefined;
  return (
    <span style={{ display: "inline-flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
      {(showEffort ?? true) && effort != null && <span className="chip">{effort} min</span>}
      {task.dueDate && (
        <span
          className="chip"
          style={
            due === "overdue" || due === "today"
              ? { borderColor: "var(--danger)", color: "var(--danger)" }
              : due === "soon"
                ? { borderColor: "var(--warn)", color: "var(--warn)" }
                : undefined
          }
        >
          {due === "overdue" ? "overdue " : "due "}
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
        <span
          className="chip"
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
