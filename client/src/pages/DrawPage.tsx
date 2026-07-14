import { useState } from "react";
import { Link } from "react-router-dom";
import confetti from "canvas-confetti";
import { useCategories, useDeleteTask, useSettings, useUpdateTask } from "../hooks/useTasks";
import { useGoals } from "../hooks/useGoals";
import { useDraw, type DrawResponse } from "../hooks/useDraw";
import { useStartTimer } from "../hooks/useTimer";
import { TaskBadges } from "../components/TaskBadges";
import { TaskForm } from "../components/TaskForm";
import { TrophyDeck } from "../components/TrophyDeck";
import { classifyTask } from "../lib/drawable";
import type { NewTask } from "../api/types";
import "./DrawPage.css";

type Phase = "idle" | "shuffling" | "revealed";

export function DrawPage() {
  const categories = useCategories();
  const settings = useSettings();
  const draw = useDraw();
  const updateTask = useUpdateTask();
  const deleteTask = useDeleteTask();
  const startTimer = useStartTimer();

  const goals = useGoals();
  const [categoryId, setCategoryId] = useState<number | undefined>();
  const [goalId, setGoalId] = useState<number | undefined>();
  const [phase, setPhase] = useState<Phase>("idle");
  const [result, setResult] = useState<DrawResponse | null>(null);
  const [editing, setEditing] = useState(false);
  const [edited, setEdited] = useState(false);

  async function doDraw() {
    setPhase("shuffling");
    setResult(null);
    setEditing(false);
    setEdited(false);
    const [response] = await Promise.all([
      draw.mutateAsync({ categoryId, goalId }),
      new Promise((r) => setTimeout(r, 450)), // let the shuffle play
    ]);
    setResult(response);
    setPhase(response.task ? "revealed" : "idle");
  }

  // The card renders from local state, so the PATCH response must be written
  // back into `result` — query invalidation alone would not refresh it.
  async function saveEdit(patch: NewTask) {
    if (!result?.task) return;
    const response = await updateTask.mutateAsync({ id: result.task.id, ...patch });
    setResult((prev) => (prev ? { ...prev, task: response.task } : prev));
    setEdited(true);
    setEditing(false);
  }

  async function deleteDrawn() {
    if (!result?.task) return;
    if (!confirm(`Delete "${result.task.title}"?`)) return;
    await deleteTask.mutateAsync(result.task.id);
    setResult(null);
    setEditing(false);
    setPhase("idle");
  }

  async function completeDrawn() {
    if (!result?.task) return;
    await updateTask.mutateAsync({ id: result.task.id, status: "done", wasDrawn: true });
    confetti({ particleCount: 120, spread: 75, origin: { y: 0.6 } });
    setResult(null);
    setPhase("idle");
  }

  const task = result?.task ?? null;
  const category = task ? categories.data?.find((c) => c.id === task.categoryId) : null;
  const maxEffort = Number(settings.data?.max_draw_effort ?? 30);
  // An edit can push the drawn card out of the deck (effort too big/cleared,
  // status no longer open) — computed client-side, mirroring drawService.
  const nonDrawable =
    task != null && (task.status !== "open" || classifyTask(task, maxEffort) !== "ready");

  return (
    <div className="content" style={{ textAlign: "center" }}>
      <h1>Draw a card</h1>
      <p style={{ color: "var(--text-dim)" }}>
        Stop choosing. Draw one small task and just start.
      </p>

      <div className="draw-filters">
        <span
          className={`chip ${categoryId === undefined ? "active" : ""}`}
          onClick={() => setCategoryId(undefined)}
        >
          All
        </span>
        {categories.data?.map((c) => (
          <span
            key={c.id}
            className={`chip ${categoryId === c.id ? "active" : ""}`}
            onClick={() => setCategoryId(c.id)}
          >
            <span className="dot" style={{ background: c.color }} />
            {c.name}
          </span>
        ))}
        {goals.data && goals.data.length > 0 && (
          <select
            value={goalId ?? ""}
            onChange={(e) => setGoalId(e.target.value === "" ? undefined : Number(e.target.value))}
            style={{ padding: "2px 8px", fontSize: 13, borderRadius: 999 }}
          >
            <option value="">any goal</option>
            {goals.data.map((g) => (
              <option key={g.id} value={g.id}>
                🎯 {g.title}
              </option>
            ))}
          </select>
        )}
      </div>

      <div className="draw-scene">
        <div
          className={`draw-card ${phase === "revealed" ? "flipped" : ""} ${
            phase === "shuffling" ? "shuffling" : ""
          }`}
        >
          <div className="draw-face front" onClick={phase === "idle" ? doDraw : undefined}>
            🃏
            <div style={{ fontSize: 15, marginTop: 12, color: "var(--text-dim)" }}>
              {phase === "shuffling" ? "shuffling…" : "click to draw"}
            </div>
          </div>
          <div className="draw-face back">
            {task && (
              <>
                {category && (
                  <span className="chip">
                    <span className="dot" style={{ background: category.color }} />
                    {category.name}
                  </span>
                )}
                <h2>{task.title}</h2>
                {task.description && (
                  <p style={{ color: "var(--text-dim)", margin: 0 }}>{task.description}</p>
                )}
                <TaskBadges task={task} />
                {nonDrawable && (
                  <div className="draw-hint">
                    This card is now out of the deck — draw again for a playable one.
                  </div>
                )}
                {/* The odds reflect the original draw; hide them once the
                    task was edited instead of showing a stale number. */}
                {!edited && result?.probability != null && (
                  <div className="draw-chance">
                    {Math.round(result.probability * 100)}% draw chance · {result.poolSize} card
                    {result.poolSize === 1 ? "" : "s"} in the deck
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>

      {phase === "revealed" && task && !editing && (
        <div className="draw-actions">
          <button
            className={nonDrawable ? undefined : "primary"}
            onClick={() => startTimer.mutate(task.id)}
          >
            ▶ Start now
          </button>
          <button onClick={completeDrawn}>✓ Done</button>
          <button onClick={() => setEditing(true)}>✎ Edit</button>
          <button onClick={deleteDrawn} title="Delete task">
            🗑 Delete
          </button>
          <button className={nonDrawable ? "primary" : undefined} onClick={doDraw}>
            Draw again
          </button>
        </div>
      )}

      {phase === "revealed" && task && editing && (
        <div className="panel" style={{ maxWidth: 680, margin: "8px auto 0", textAlign: "left" }}>
          <TaskForm
            key={task.id}
            categories={categories.data ?? []}
            goals={goals.data}
            initial={task}
            autoFocus
            submitLabel="Save"
            onSubmit={saveEdit}
            onCancel={() => setEditing(false)}
          />
        </div>
      )}

      <TrophyDeck />

      {phase === "idle" && result && !result.task && (
        <div className="panel" style={{ maxWidth: 420, margin: "0 auto" }}>
          {result.reason === "all_too_big" ? (
            <p>
              Everything left is too big or unestimated. <Link to="/capture" style={{ color: "var(--accent)" }}>Break something down</Link> to refill the deck.
            </p>
          ) : (
            <p>
              The deck is empty. <Link to="/capture" style={{ color: "var(--accent)" }}>Capture a task</Link> to get started.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
