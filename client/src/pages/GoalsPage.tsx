import { useState } from "react";
import type { Goal } from "../api/types";
import { useCreateGoal, useDeleteGoal, useUpdateGoal, useGoals } from "../hooks/useGoals";
import { useCategories, useCreateTask } from "../hooks/useTasks";
import { useAiStatus } from "../hooks/useAi";
import { MaterialsSection } from "../components/MaterialsSection";
import { AiPlanPanel } from "../components/AiSuggestionPanel";

function daysUntil(dateStr: string): number {
  const target = new Date(`${dateStr}T23:59:59`);
  return Math.ceil((target.getTime() - Date.now()) / (24 * 3600 * 1000));
}

function GoalCard({ goal }: { goal: Goal }) {
  const updateGoal = useUpdateGoal();
  const deleteGoal = useDeleteGoal();
  const createTask = useCreateTask();
  const categories = useCategories();
  const aiStatus = useAiStatus();
  const [showMaterials, setShowMaterials] = useState(false);
  const [planning, setPlanning] = useState(false);
  const [planCategoryId, setPlanCategoryId] = useState<number | null>(null);

  const days = goal.targetDate ? daysUntil(goal.targetDate) : null;
  const progress = goal.taskCount > 0 ? goal.doneCount / goal.taskCount : 0;
  const defaultCategory =
    categories.data?.find((c) => c.name === "Study")?.id ?? categories.data?.[0]?.id ?? 1;

  return (
    <div className="panel" style={{ marginTop: 16 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
        <h3 style={{ margin: 0, flex: 1 }}>🎯 {goal.title}</h3>
        {days != null && (
          <span
            className="chip"
            style={days <= 7 ? { borderColor: "var(--danger)", color: "var(--danger)" } : undefined}
          >
            {days < 0 ? `${-days}d overdue` : `${days}d left`}
          </span>
        )}
        <button
          style={{ padding: "2px 10px" }}
          onClick={() => updateGoal.mutate({ id: goal.id, status: "achieved" })}
          title="Mark achieved"
        >
          🏁
        </button>
        <button
          style={{ padding: "2px 10px" }}
          onClick={() => {
            if (confirm(`Delete goal "${goal.title}"? Tasks stay, but lose the link.`)) {
              deleteGoal.mutate(goal.id);
            }
          }}
        >
          🗑
        </button>
      </div>
      {goal.outcome && (
        <p style={{ color: "var(--text-dim)", margin: "8px 0 0" }}>
          <strong>Measured by:</strong> {goal.outcome}
        </p>
      )}
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 12 }}>
        <div style={{ flex: 1, background: "var(--bg)", borderRadius: 6, height: 8 }}>
          <div
            style={{
              width: `${progress * 100}%`,
              height: "100%",
              borderRadius: 6,
              background: "var(--ok)",
            }}
          />
        </div>
        <span style={{ fontSize: 13, color: "var(--text-dim)" }}>
          {goal.doneCount}/{goal.taskCount} tasks
        </span>
        <button style={{ padding: "2px 10px" }} onClick={() => setShowMaterials((s) => !s)}>
          📎 {goal.materialCount}
        </button>
        {aiStatus.data?.configured && (
          <>
            <button
              style={{ padding: "2px 10px", borderColor: "var(--accent)" }}
              onClick={() => setPlanning((p) => !p)}
            >
              ✨ Plan backward
            </button>
            {planning && (
              <select
                value={planCategoryId ?? defaultCategory}
                onChange={(e) => setPlanCategoryId(Number(e.target.value))}
                title="Category for accepted tasks"
              >
                {categories.data?.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            )}
          </>
        )}
      </div>
      {showMaterials && <MaterialsSection goalId={goal.id} />}
      {planning && (
        <AiPlanPanel
          goalId={goal.id}
          onClose={() => setPlanning(false)}
          onAccept={async (tasks) => {
            for (const t of tasks) {
              await createTask.mutateAsync({
                title: t.title,
                categoryId: planCategoryId ?? defaultCategory,
                goalId: goal.id,
                impact: t.impact,
                effortMinutes: t.effortMinutes,
              });
            }
          }}
        />
      )}
    </div>
  );
}

export function GoalsPage() {
  const goals = useGoals();
  const createGoal = useCreateGoal();
  const [title, setTitle] = useState("");
  const [outcome, setOutcome] = useState("");
  const [targetDate, setTargetDate] = useState("");

  return (
    <div className="content">
      <h1>Goals</h1>
      <div className="panel">
        <form
          style={{ display: "grid", gap: 8 }}
          onSubmit={async (e) => {
            e.preventDefault();
            if (!title.trim()) return;
            await createGoal.mutateAsync({
              title: title.trim(),
              outcome: outcome.trim() || undefined,
              targetDate: targetDate || null,
            });
            setTitle("");
            setOutcome("");
            setTargetDate("");
          }}
        >
          <div style={{ display: "flex", gap: 8 }}>
            <input
              placeholder="Goal — e.g. Pass the statistics exam"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              style={{ flex: 1 }}
            />
            <input
              type="date"
              value={targetDate}
              onChange={(e) => setTargetDate(e.target.value)}
              title="Target date"
            />
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              placeholder="How is success measured? — e.g. written exam, 60% to pass, past papers available"
              value={outcome}
              onChange={(e) => setOutcome(e.target.value)}
              style={{ flex: 1 }}
            />
            <button type="submit" className="primary">
              Add goal
            </button>
          </div>
        </form>
      </div>
      {goals.data?.map((g) => <GoalCard key={g.id} goal={g} />)}
      {(goals.data?.length ?? 0) === 0 && (
        <p style={{ color: "var(--text-dim)", marginTop: 16 }}>
          No active goals. A goal gives your tasks an impact rating — and a reason.
        </p>
      )}
    </div>
  );
}
