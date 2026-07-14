import { useState } from "react";
import { Link } from "react-router-dom";
import confetti from "canvas-confetti";
import { useCategories, useUpdateTask } from "../hooks/useTasks";
import { useGoals } from "../hooks/useGoals";
import { useDraw, type DrawResponse } from "../hooks/useDraw";
import { useStartTimer } from "../hooks/useTimer";
import { TaskBadges } from "../components/TaskBadges";
import { TrophyDeck } from "../components/TrophyDeck";
import "./DrawPage.css";

type Phase = "idle" | "shuffling" | "revealed";

export function DrawPage() {
  const categories = useCategories();
  const draw = useDraw();
  const updateTask = useUpdateTask();
  const startTimer = useStartTimer();

  const goals = useGoals();
  const [categoryId, setCategoryId] = useState<number | undefined>();
  const [goalId, setGoalId] = useState<number | undefined>();
  const [phase, setPhase] = useState<Phase>("idle");
  const [result, setResult] = useState<DrawResponse | null>(null);

  async function doDraw() {
    setPhase("shuffling");
    setResult(null);
    const [response] = await Promise.all([
      draw.mutateAsync({ categoryId, goalId }),
      new Promise((r) => setTimeout(r, 450)), // let the shuffle play
    ]);
    setResult(response);
    setPhase(response.task ? "revealed" : "idle");
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
                {result?.probability != null && (
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

      {phase === "revealed" && task && (
        <div className="draw-actions">
          <button className="primary" onClick={() => startTimer.mutate(task.id)}>
            ▶ Start now
          </button>
          <button onClick={completeDrawn}>✓ Done</button>
          <button onClick={doDraw}>Draw again</button>
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
