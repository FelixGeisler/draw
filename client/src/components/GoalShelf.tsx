import { useState } from "react";
import type { Goal } from "../api/types";
import { useDeleteGoal, useGoals, useUpdateGoal } from "../hooks/useGoals";
import { formatResolvedDate, targetDelta } from "../lib/goalShelf";
// The committed gold trophy-cup art (#124), reused here as the shared trophy
// image — a string URL Vite fingerprints into the bundle (vite-env.d.ts).
import trophyCup from "../assets/achievements/first_goal.svg";
import "./GoalShelf.css";

/**
 * Hall of Fame (#145, redesigned as a trophy cabinet in #168): resolved goals
 * below the active list — achieved goals as gold cups standing on the glass
 * shelves of a lit display case, missed ones in a deliberately quiet section
 * beneath. Collapsed by default; the content is its own component so the
 * achieved/missed queries only run while the shelf is open (the LinkTaskPicker
 * pattern). "GoalShelf", not "TrophyShelf": TrophyDeck is already the Draw
 * page's today-completions pile.
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

  // No empty-state flash on first expand: the two queries only start when
  // the content mounts, so "nothing yet" is a claim we can't make until
  // both have actually answered.
  if (achieved.isPending || missed.isPending) return null;

  const achievedGoals = achieved.data ?? [];
  const missedGoals = missed.data ?? [];

  return (
    <>
      {/* The display case: a lit dark-glass cabinet whether it holds trophies
          or stands empty — an empty case is its own invitation. */}
      <div className="goal-cabinet">
        {achievedGoals.length === 0 ? (
          <p className="goal-cabinet-empty">
            The cabinet is empty — finish a goal to earn its first trophy.
          </p>
        ) : (
          // flex-wrap flows trophies by width; align-items:flex-start pins each
          // trophy's fixed-height stand to the top, so every ledge (the stand's
          // lower edge) lands at the same y within a wrapped row and the
          // per-trophy ledge segments meet into one continuous shelf line —
          // robust for 1..N trophies, one shelf per wrapped row (CSS).
          <div className="goal-cabinet-shelves">
            {achievedGoals.map((goal) => {
              const delta = targetDelta(goal.targetDate, goal.resolvedAt);
              return (
                <div key={goal.id} className="goal-trophy">
                  <div className="goal-trophy-stand">
                    <img className="goal-trophy-cup" src={trophyCup} alt="" aria-hidden="true" />
                    <span className="goal-trophy-plinth" aria-hidden="true" />
                  </div>
                  <div className="goal-trophy-plaque">
                    <div className="goal-trophy-title">{goal.title}</div>
                    <div className="goal-trophy-meta">
                      {/* No date on pre-v12 trophies: resolvedAt NULL = unknown. */}
                      {goal.resolvedAt && <span>Achieved {formatResolvedDate(goal.resolvedAt)}</span>}
                      <span>
                        ✓ {goal.doneCount}/{goal.taskCount} tasks
                      </span>
                      {delta && <span className="goal-trophy-delta">{delta}</span>}
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
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Missed goals: recorded, not enshrined — a quiet section BELOW the
          case, never inside it. */}
      {missedGoals.length > 0 && (
        <div className="goal-missed">
          <h3 className="goal-missed-header">Didn’t make the cabinet</h3>
          <div className="goal-missed-list">
            {missedGoals.map((goal) => (
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
        </div>
      )}
    </>
  );
}
