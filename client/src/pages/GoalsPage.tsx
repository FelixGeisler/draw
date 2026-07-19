import { useState } from "react";
import type { Goal } from "../api/types";
import { useCreateGoal, useDeleteGoal, useUpdateGoal, useGoals } from "../hooks/useGoals";
import { useCategories, useCreateTask } from "../hooks/useTasks";
import { useAiStatus } from "../hooks/useAi";
import { GoalShelf } from "../components/GoalShelf";
import { GoalTasksSection } from "../components/GoalTasksSection";
import { MaterialsSection } from "../components/MaterialsSection";
import { AiGenerateTasksPanel, AiPlanPanel } from "../components/AiSuggestionPanel";
import { TaskForm } from "../components/TaskForm";
import { VictoryOverlay } from "../components/VictoryOverlay";
import { daysUntil, feasibility, type Feasibility } from "../lib/feasibility";

const VERDICT_STYLE = {
  "on-track": { label: "On track", color: "var(--ok)" },
  tight: { label: "Tight", color: "var(--warn)" },
  infeasible: { label: "Infeasible", color: "var(--danger)" },
} as const;

/**
 * Burn-down chip (#60) next to the days-left chip. "unknown" shows the
 * required pace without a verdict (no history to compare against); the
 * infeasible chip carries the ✨ Re-plan shortcut — it only opens the same
 * Plan-backward panel as the button below, no second AI path.
 */
function FeasibilityChip({ f, onReplan }: { f: Feasibility; onReplan?: () => void }) {
  const pace = (n: number) => `~${Math.round(n)} min/day`;
  if (f.state === "done") return <span className="chip">All tasks done</span>;
  if (f.state === "unknown") {
    return (
      <span className="chip" title="Nothing tracked on this goal in the last 14 days — no verdict yet">
        Need {pace(f.requiredPaceMinutesPerDay)}
      </span>
    );
  }
  const { label, color } = VERDICT_STYLE[f.state];
  return (
    <span className="chip" style={{ borderColor: color, color }}>
      {label} — need {pace(f.requiredPaceMinutesPerDay)}
      {f.actualPaceMinutesPerDay !== null && `, doing ${pace(f.actualPaceMinutesPerDay)}`}
      {f.state === "infeasible" && onReplan && (
        <button
          style={{ padding: "0 6px", borderColor: "var(--accent)" }}
          onClick={onReplan}
          title="Re-plan this goal backward from the target date"
        >
          ✨ Re-plan
        </button>
      )}
    </span>
  );
}

function GoalCard({
  goal,
  allGoals,
  onAchieved,
  onMissed,
}: {
  goal: Goal;
  allGoals: Goal[];
  /** Server-confirmed achieve (#145): the PATCH response opens the victory overlay. */
  onAchieved: (goal: Goal) => void;
  /** Quiet counterpart: feeds the page's live region — no fanfare for a defeat. */
  onMissed: (title: string) => void;
}) {
  const updateGoal = useUpdateGoal();
  const deleteGoal = useDeleteGoal();
  const createTask = useCreateTask();
  const categories = useCategories();
  const aiStatus = useAiStatus();
  const [showMaterials, setShowMaterials] = useState(false);
  const [showTasks, setShowTasks] = useState(false);
  // Plan backward and Generate tasks share the category select — one panel at a time.
  const [aiPanel, setAiPanel] = useState<"plan" | "generate" | null>(null);
  const [planCategoryId, setPlanCategoryId] = useState<number | null>(null);
  const [addingTask, setAddingTask] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const [editOutcome, setEditOutcome] = useState("");
  const [editDate, setEditDate] = useState("");

  const days = goal.targetDate ? daysUntil(goal.targetDate) : null;
  const feas = feasibility(goal);
  const progress = goal.taskCount > 0 ? goal.doneCount / goal.taskCount : 0;
  const defaultCategory =
    categories.data?.find((c) => c.name === "Study")?.id ?? categories.data?.[0]?.id ?? 1;

  function startEdit() {
    setEditTitle(goal.title);
    setEditOutcome(goal.outcome ?? "");
    setEditDate(goal.targetDate ?? "");
    setEditing(true);
  }

  return (
    <div className="panel" style={{ marginTop: 16 }}>
      {editing ? (
        <form
          style={{ display: "grid", gap: 8 }}
          onSubmit={async (e) => {
            e.preventDefault();
            if (!editTitle.trim()) return;
            await updateGoal.mutateAsync({
              id: goal.id,
              title: editTitle.trim(),
              outcome: editOutcome.trim() || null,
              // Empty date clears the target — the days-left chip disappears.
              targetDate: editDate || null,
            });
            setEditing(false);
          }}
        >
          <div style={{ display: "flex", gap: 8 }}>
            <input
              autoFocus
              title="Goal title"
              placeholder="Goal — e.g. Pass the statistics exam"
              value={editTitle}
              onChange={(e) => setEditTitle(e.target.value)}
              style={{ flex: 1 }}
            />
            <input
              type="date"
              title="Goal target date"
              value={editDate}
              onChange={(e) => setEditDate(e.target.value)}
            />
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              title="Goal outcome"
              placeholder="How is success measured? — e.g. written exam, 60% to pass, past papers available"
              value={editOutcome}
              onChange={(e) => setEditOutcome(e.target.value)}
              style={{ flex: 1 }}
            />
            <button type="submit" className="primary">
              Save
            </button>
            <button type="button" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <>
          {/* flexWrap: the feasibility chip (#60) can be long — wrapping keeps
              the title readable instead of crushing it. */}
          <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
            <h3 style={{ margin: 0, flex: 1 }}>🎯 {goal.title}</h3>
            {days != null && (
              <span
                className="chip"
                style={
                  days <= 7 ? { borderColor: "var(--danger)", color: "var(--danger)" } : undefined
                }
              >
                {days < 0 ? `${-days}d overdue` : `${days}d left`}
              </span>
            )}
            {feas && (
              <FeasibilityChip
                f={feas}
                onReplan={aiStatus.data?.configured ? () => setAiPanel("plan") : undefined}
              />
            )}
            <button style={{ padding: "2px 10px" }} onClick={startEdit} title="Edit goal">
              ✎
            </button>
            <button
              style={{ padding: "2px 10px" }}
              // Per-call onSuccess: the celebration waits for the server to
              // confirm (#110 — never before), and the response carries the
              // stamped resolvedAt the overlay shows.
              onClick={() =>
                updateGoal.mutate(
                  { id: goal.id, status: "achieved" },
                  { onSuccess: (g) => onAchieved(g) },
                )
              }
              title="Mark achieved"
            >
              🏁
            </button>
            <button
              style={{ padding: "2px 10px" }}
              onClick={() => {
                if (
                  confirm(
                    `Mark goal "${goal.title}" as missed? It moves to the Hall of Fame — you can reactivate it anytime.`,
                  )
                ) {
                  updateGoal.mutate(
                    { id: goal.id, status: "missed" },
                    { onSuccess: () => onMissed(goal.title) },
                  );
                }
              }}
              title="Mark missed — the goal is over but wasn't reached"
            >
              ⌛
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
        </>
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
        {/* The progress count doubles as the toggle for the Tasks section
            (#87) — same collapsible pattern as the 📎 materials button. */}
        <button
          style={{ padding: "2px 10px" }}
          onClick={() => setShowTasks((s) => !s)}
          title="Show this goal's tasks — unlink or attach existing ones"
        >
          {goal.doneCount}/{goal.taskCount} tasks
        </button>
        <button style={{ padding: "2px 10px" }} onClick={() => setAddingTask((a) => !a)}>
          + Add task
        </button>
        <button style={{ padding: "2px 10px" }} onClick={() => setShowMaterials((s) => !s)}>
          📎 {goal.materialCount}
        </button>
        {aiStatus.data?.configured && (
          <>
            <button
              style={{ padding: "2px 10px", borderColor: "var(--accent)" }}
              onClick={() => setAiPanel((p) => (p === "plan" ? null : "plan"))}
            >
              ✨ Plan backward
            </button>
            <button
              style={{ padding: "2px 10px", borderColor: "var(--accent)" }}
              onClick={() => setAiPanel((p) => (p === "generate" ? null : "generate"))}
            >
              ✨ Generate tasks
            </button>
            {aiPanel && (
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
      {addingTask && (
        <div style={{ marginTop: 12 }}>
          <TaskForm
            categories={categories.data ?? []}
            goals={allGoals}
            initial={{ goalId: goal.id, categoryId: defaultCategory }}
            autoFocus
            onSubmit={async (task) => {
              await createTask.mutateAsync(task);
              setAddingTask(false);
            }}
            onCancel={() => setAddingTask(false)}
          />
        </div>
      )}
      {showTasks && <GoalTasksSection goalId={goal.id} />}
      {showMaterials && <MaterialsSection goalId={goal.id} />}
      {aiPanel === "plan" && (
        <AiPlanPanel
          goalId={goal.id}
          onClose={() => setAiPanel(null)}
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
      {aiPanel === "generate" && (
        <AiGenerateTasksPanel
          goalId={goal.id}
          goalTitle={goal.title}
          categoryId={planCategoryId ?? defaultCategory}
          onClose={() => setAiPanel(null)}
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
  // The goal being celebrated (#145) — set from the server-confirmed PATCH
  // response, so the overlay shows the stamped resolvedAt, not a client guess.
  const [victory, setVictory] = useState<Goal | null>(null);
  const [missedNotice, setMissedNotice] = useState<string | null>(null);

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
      {goals.data?.map((g) => (
        <GoalCard
          key={g.id}
          goal={g}
          allGoals={goals.data ?? []}
          onAchieved={setVictory}
          onMissed={(t) => setMissedNotice(`Moved "${t}" to the Hall of Fame as missed.`)}
        />
      ))}
      {(goals.data?.length ?? 0) === 0 && (
        <p style={{ color: "var(--text-dim)", marginTop: 16 }}>
          No active goals. A goal gives your tasks an impact rating — and a reason.
        </p>
      )}
      {/* Always-mounted live region (the GoalTasksSection pattern): screen
          readers only reliably announce a role="status" whose container
          pre-exists its text, and this line is the whole feedback for a row
          that just left the list — marking missed is quiet by design. */}
      <div
        role="status"
        style={{ marginTop: missedNotice ? 12 : 0, fontSize: 13, color: "var(--text-dim)" }}
      >
        {missedNotice}
      </div>
      <GoalShelf onReactivated={() => setMissedNotice(null)} />
      {victory && <VictoryOverlay goal={victory} onClose={() => setVictory(null)} />}
    </div>
  );
}
