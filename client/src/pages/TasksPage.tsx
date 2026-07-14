import { useState } from "react";
import { useCategories, useSettings, useTasks } from "../hooks/useTasks";
import { useGoals } from "../hooks/useGoals";
import { TaskRow } from "../components/TaskRow";

export function TasksPage() {
  const categories = useCategories();
  const goals = useGoals();
  const settings = useSettings();
  const [showDone, setShowDone] = useState(false);
  const tasks = useTasks({ status: showDone ? "all" : "open" });

  const maxEffort = Number(settings.data?.max_draw_effort ?? 30);

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
        const catTasks = (tasks.data ?? []).filter((t) => t.categoryId === cat.id);
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
      {(tasks.data?.length ?? 0) === 0 && (
        <p style={{ color: "var(--text-dim)" }}>No tasks yet — head to Capture.</p>
      )}
    </div>
  );
}
