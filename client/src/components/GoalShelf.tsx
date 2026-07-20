import type { Goal } from "../api/types";
import { useDeleteGoal, useGoals, useUpdateGoal } from "../hooks/useGoals";
import { formatResolvedDate } from "../lib/goalShelf";
// The committed gold trophy-cup art (#124), reused here as the shared trophy
// image — a string URL Vite fingerprints into the bundle (vite-env.d.ts).
import trophyCup from "../assets/goal-trophy.svg";
import "./GoalShelf.css";

/**
 * Hall of Fame (#145 → #168 cabinet → #181 spotlight showcase): resolved goals
 * below the active list. ALWAYS visible now (#181, no collapse toggle) — the
 * user asked twice for the trophies to greet them, not hide behind a click.
 * Each achieved goal is a gold cup standing in its own soft spotlight; at rest
 * ONLY its name shows, and hover/focus reveals a quiet `Achieved <date>` +
 * Reactivate / Delete strip, absolutely positioned so revealing never reflows
 * the case. Missed goals sit as deliberately quiet rows beneath. "GoalShelf",
 * not "TrophyShelf": TrophyDeck is already the Draw page's today-completions
 * pile.
 *
 * The two achieved/missed queries run on every page load now (the shelf is no
 * longer mounted only-while-open), but the pending guard stays: "nothing yet"
 * is a claim we can't make until both queries have actually answered, so we
 * render nothing rather than flash an empty case.
 */
export function GoalShelf({ onReactivated }: { onReactivated?: () => void }) {
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

  if (achieved.isPending || missed.isPending) return null;

  const achievedGoals = achieved.data ?? [];
  const missedGoals = missed.data ?? [];

  return (
    <div className="goal-shelf">
      {/* The display case: a minimalist dark cabinet where the drama is light,
          not furniture — each cup stands in its own spotlight (#181). Rendered
          unconditionally; an empty case is its own invitation. */}
      <div className="goal-cabinet">
        <h2 className="goal-cabinet-title">
          <span className="goal-cabinet-cup" aria-hidden="true">
            🏆
          </span>
          Hall of Fame
        </h2>
        <div className="goal-cabinet-shelf">
          {achievedGoals.length === 0 ? (
            // Empty state: a ghost cup under a dim beam, spotlit and waiting.
            <div className="goal-cabinet-empty">
              <div className="goal-cup-stage">
                <span className="goal-cup-beam goal-cup-beam--dim" aria-hidden="true" />
                <span className="goal-cup-pool goal-cup-pool--dim" aria-hidden="true" />
                <img
                  className="goal-cup-art goal-cup-art--ghost"
                  src={trophyCup}
                  alt=""
                  aria-hidden="true"
                />
              </div>
              <p className="goal-cabinet-empty-text">Finish a goal to earn its first trophy.</p>
            </div>
          ) : (
            <div className="goal-cabinet-row">
              {achievedGoals.map((goal) => (
                <div key={goal.id} className="goal-cup">
                  <div className="goal-cup-stage">
                    <span className="goal-cup-beam" aria-hidden="true" />
                    <span className="goal-cup-pool" aria-hidden="true" />
                    <span className="goal-cup-shadow" aria-hidden="true" />
                    <img className="goal-cup-art" src={trophyCup} alt="" aria-hidden="true" />
                  </div>
                  <div className="goal-cup-name">{goal.title}</div>
                  {/* Reveal strip: absolutely positioned into space the cup
                      always reserves, so fading it in on hover/focus-within
                      never reflows the case. focus-within keeps the actions
                      reachable by keyboard, never hover-only. */}
                  <div className="goal-cup-reveal">
                    {/* No date on pre-v12 trophies: resolvedAt NULL = unknown. */}
                    {goal.resolvedAt && (
                      <div className="goal-cup-date">Achieved {formatResolvedDate(goal.resolvedAt)}</div>
                    )}
                    <div className="goal-cup-actions">
                      <button onClick={() => reactivate(goal)} title="Back to the active list">
                        ↩ Reactivate
                      </button>
                      <button
                        className="goal-ghost-danger"
                        onClick={() => remove(goal)}
                        title="Delete goal"
                      >
                        🗑 Delete
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Missed goals: recorded, not enshrined — a quiet section BELOW the
          case, never inside it. Name-only at rest; the row reserves the reveal
          in flow (opacity-only toggle), so it never reflows either. */}
      {missedGoals.length > 0 && (
        <div className="goal-missed">
          <h3 className="goal-missed-header">Didn’t make the cabinet</h3>
          <div className="goal-missed-list">
            {missedGoals.map((goal) => (
              <div key={goal.id} className="goal-missed-row">
                <span className="goal-missed-name">{goal.title}</span>
                <span className="goal-missed-reveal">
                  {/* No date on pre-v12 rows: resolvedAt NULL = unknown. */}
                  {goal.resolvedAt && (
                    <span className="goal-missed-date">missed {formatResolvedDate(goal.resolvedAt)}</span>
                  )}
                  <span className="goal-missed-actions">
                    <button onClick={() => reactivate(goal)} title="Back to the active list">
                      ↩ Reactivate
                    </button>
                    <button
                      className="goal-ghost-danger"
                      onClick={() => remove(goal)}
                      title="Delete goal"
                    >
                      🗑 Delete
                    </button>
                  </span>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
