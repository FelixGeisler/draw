import { useState } from "react";
import { useCategories, useSettings, useTasks } from "../hooks/useTasks";
import { useGoals } from "../hooks/useGoals";
import { TaskRow } from "../components/TaskRow";
import { classifyTask } from "../lib/drawable";
import type { Task } from "../api/types";

export function TasksPage() {
  const categories = useCategories();
  const goals = useGoals();
  const settings = useSettings();
  const [showDone, setShowDone] = useState(false);
  const tasks = useTasks({ status: showDone ? "all" : "open" });

  const maxEffort = Number(settings.data?.max_draw_effort ?? 30);
  // Snoozed/blocked roots leave the main view but stay findable below.
  // classifyTask (not bare isSnoozed) keeps blocked containers in the main
  // list — their open subtasks are still visible, in the deck, and workable.
  const isSnoozedRoot = (t: Task) =>
    t.status === "open" && classifyTask(t, maxEffort) === "snoozed";
  const snoozedRoots = (tasks.data ?? []).filter(isSnoozedRoot);

  return (
    <div className="content">
      <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
        <h1 style={{ flex: 1 }}>Tasks</h1>
        <label style={{ color: "var(--text-dim)", display: "flex", gap: 6, alignItems: "center" }}>
          <input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} />
          show done
        </label>
      </div>
      {categories.data?.map((cat) => {
        const catTasks = (tasks.data ?? []).filter(
          (t) => t.categoryId === cat.id && !isSnoozedRoot(t),
        );
        if (catTasks.length === 0) return null;
        return (
          <section key={cat.id} style={{ marginTop: 20 }}>
            <h3>
              <span className="dot" style={{ background: cat.color, marginRight: 8 }} />
            {cat.name}
            </h3>
            <div className="panel" style={{ padding: "0 8px" }}>
              {catTasks.map((t) => (
                <TaskRow
                  key={t.id}
                  task={t}
                  categories={categories.data!}
                  goals={goals.data}
                  maxEffort={maxEffort}
                />
              ))}
            </div>
          </section>
        );
      })}
      {snoozedRoots.length > 0 && (
        <details style={{ marginTop: 24 }}>
          <summary style={{ cursor: "pointer", color: "var(--text-dim)" }}>
            💤 Snoozed ({snoozedRoots.length})
          </summary>
          <div className="panel" style={{ padding: "0 8px", marginTop: 8 }}>
            {snoozedRoots.map((t) => (
              <TaskRow key={t.id} task={t} categories={categories.data ?? []} maxEffort={maxEffort} />
            ))}
          </div>
        </details>
      )}
      {(tasks.data?.length ?? 0) === 0 && (
        <p style={{ color: "var(--text-dim)" }}>No tasks yet — head to Capture.</p>
      )}
    </div>
  );
}
