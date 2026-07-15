import { useCategories, useCreateTask, useSettings, useTasks, useUpdateTask } from "../hooks/useTasks";
import { useGoals } from "../hooks/useGoals";
import { TaskForm } from "../components/TaskForm";
import { TaskBadges } from "../components/TaskBadges";
import { classifyTask, flattenOpen, type DrawGroup } from "../lib/drawable";
import type { Task } from "../api/types";

const GROUPS: { key: DrawGroup; title: string; hint: string }[] = [
  { key: "ready", title: "✅ Ready to draw", hint: "Small enough — these are in the deck." },
  { key: "needs-estimate", title: "⏱ Needs an estimate", hint: "Add minutes so they can enter the deck." },
  { key: "too-big", title: "🐘 Too big — break these down", hint: "Over the limit. Split them into small steps." },
  { key: "snoozed", title: "💤 Snoozed", hint: "Out of the deck for now — they wake on their own, or from the Tasks page." },
  { key: "queued", title: "⏳ Queued", hint: "Sequential breakdowns — these enter the deck when the steps in front of them close." },
  { key: "scheduled", title: "🕒 Scheduled", hint: "Outside their availability window right now — they return on their own." },
];

function EstimateInput({ task }: { task: Task }) {
  const updateTask = useUpdateTask();
  return (
    <input
      type="number"
      min={1}
      placeholder="min"
      style={{ width: 70 }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          const v = Number((e.target as HTMLInputElement).value);
          if (v > 0) updateTask.mutate({ id: task.id, effortMinutes: v });
        }
      }}
    />
  );
}

export function CapturePage() {
  const categories = useCategories();
  const goals = useGoals();
  const settings = useSettings();
  const tasks = useTasks();
  const createTask = useCreateTask();

  const maxEffort = Number(settings.data?.max_draw_effort ?? 30);
  const open = flattenOpen(tasks.data ?? []);
  const grouped = new Map<DrawGroup, Task[]>();
  for (const t of open) {
    const g = classifyTask(t, maxEffort);
    if (g === "container") continue;
    grouped.set(g, [...(grouped.get(g) ?? []), t]);
  }

  return (
    <div className="content">
      <h1>Capture</h1>
      <div className="panel">
        {categories.data && (
          <TaskForm
            autoFocus
            categories={categories.data}
            goals={goals.data}
            onSubmit={(t) => createTask.mutateAsync(t)}
          />
        )}
      </div>
      {GROUPS.map(({ key, title, hint }) => {
        const items = grouped.get(key) ?? [];
        if (items.length === 0 && key !== "ready") return null;
        return (
          <section key={key} style={{ marginTop: 24 }}>
            <h3 style={{ marginBottom: 4 }}>
              {title} <span style={{ color: "var(--text-dim)", fontWeight: 400 }}>({items.length})</span>
            </h3>
            <p style={{ color: "var(--text-dim)", marginTop: 0, fontSize: 13 }}>{hint}</p>
            <div className="panel" style={{ padding: "4px 12px" }}>
              {items.length === 0 && (
                <p style={{ color: "var(--text-dim)" }}>Nothing here — capture something above.</p>
              )}
              {items.map((t) => (
                <div
                  key={t.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "8px 0",
                    borderBottom: "1px solid var(--border)",
                  }}
                >
                  <span style={{ flex: 1 }}>{t.title}</span>
                  <TaskBadges task={t} />
                  {key === "needs-estimate" && <EstimateInput task={t} />}
                </div>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
