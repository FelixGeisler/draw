import { useState } from "react";
import type { Goal } from "../api/types";
import { useDeleteGoal, useGoals, useUpdateGoal } from "../hooks/useGoals";
import { formatResolvedDate, targetDelta } from "../lib/goalShelf";
import "./GoalShelf.css";

/**
 * Hall of Fame (#145): resolved goals below the active list — achieved goals
 * as trophy cards, missed ones as deliberately quiet rows. Collapsed by
 * default; the content is its own component so the achieved/missed queries
 * only run while the shelf is open (the LinkTaskPicker pattern). "GoalShelf",
 * not "TrophyShelf": TrophyDeck is already the Draw page's today-completions
 * pile.
 */
export function GoalShelf({ onReactivated }: { onReactivated?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="panel goal-shelf">
      <button className="goal-shelf-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        🏆 Hall of Fame {open ? "▾" : "▸"}
      </button>
      {open && <GoalShelfContent onReactivated={onReactivated} />}
    </div>
  );
}

function GoalShelfContent({ onReactivated }: { onReactivated?: () => void }) {
  const achieved = useGoals("achieved");
  const missed = useGoals("missed");
  const updateGoal = useUpdateGoal();
  const deleteGoal = useDeleteGoal();

  function reactivate(goal: Goal) {
    // All transitions are legal server-side (ADR-38): back to active clears
    // resolved_at, and the ["goals"] prefix invalidation refreshes both the
    // shelf and the active list.
    updateGoal.mutate({ id: goal.id, status: "active" }, { onSuccess: () => onReactivated?.() });
  }

  function remove(goal: Goal) {
    if (confirm(`Delete goal "${goal.title}"? Tasks stay, but lose the link.`)) {
      deleteGoal.mutate(goal.id);
    }
  }

  if ((achieved.data?.length ?? 0) === 0 && (missed.data?.length ?? 0) === 0) {
    return (
      <p className="goal-shelf-empty">
        Nothing on the shelf yet — finish a goal to hang the first trophy.
      </p>
    );
  }

  return (
    <>
      {(achieved.data?.length ?? 0) > 0 && (
        <div className="goal-trophies">
          {achieved.data?.map((goal) => {
            const delta = targetDelta(goal.targetDate, goal.resolvedAt);
            return (
              <div key={goal.id} className="goal-trophy">
                <div className="goal-trophy-title">🏆 {goal.title}</div>
                <div className="goal-trophy-meta">
                  {/* No date on pre-v12 trophies: resolvedAt NULL = unknown. */}
                  {goal.resolvedAt && <span>Achieved {formatResolvedDate(goal.resolvedAt)}</span>}
                  <span>
                    ✓ {goal.doneCount}/{goal.taskCount} tasks
                  </span>
                  {delta && <span>{delta}</span>}
                </div>
                <div className="goal-trophy-actions">
                  <button onClick={() => reactivate(goal)} title="Back to the active list">
                    ↩ Reactivate
                  </button>
                  <button onClick={() => remove(goal)} title="Delete goal">
                    🗑
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
      {(missed.data?.length ?? 0) > 0 && (
        <div className="goal-missed-list">
          {missed.data?.map((goal) => (
            <div key={goal.id} className="goal-missed-row">
              <span className="goal-missed-text">
                ⌛ {goal.title}
                <span className="goal-missed-meta">
                  {goal.resolvedAt && ` — missed ${formatResolvedDate(goal.resolvedAt)}`}
                  {` · ${goal.doneCount}/${goal.taskCount} tasks done`}
                </span>
              </span>
              <button onClick={() => reactivate(goal)} title="Back to the active list">
                ↩ Reactivate
              </button>
              <button onClick={() => remove(goal)} title="Delete goal">
                🗑
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
