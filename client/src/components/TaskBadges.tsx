import type { Task } from "../api/types";
import { isDueSoon, isSnoozed } from "../lib/drawable";
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

export function TaskBadges({ task, showStars }: { task: Task; showStars?: boolean }) {
  const due = isDueSoon(task.dueDate);
  const effort = displayEffort(task);
  return (
    <span style={{ display: "inline-flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
      {effort != null && <span className="chip">{effort} min</span>}
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
          task is snoozed (classifyTask precedence — snoozed wins). */}
      {Boolean(task.heldBack) && !isSnoozed(task) && (
        <span className="chip" title="In line — this breakdown is done in order; finish the steps in front first">
          ⏳ queued
        </span>
      )}
      {(showStars ?? task.goalId != null) && <ImpactStars value={task.impact} />}
    </span>
  );
}
