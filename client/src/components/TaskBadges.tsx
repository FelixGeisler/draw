import type { Task } from "../api/types";
import { isDueSoon } from "../lib/drawable";
import { displayEffort } from "../lib/effort";

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
      {(showStars ?? task.goalId != null) && <ImpactStars value={task.impact} />}
    </span>
  );
}
