import { useEffect } from "react";
import { createPortal } from "react-dom";
import type { Goal } from "../api/types";
import { celebrate, prefersReducedMotion, resetCelebration } from "../lib/celebrate";
import { useModalFocus } from "../hooks/useModalFocus";
import { formatResolvedDate, formatTrackedMinutes, targetDelta } from "../lib/goalShelf";
import "./VictoryOverlay.css";

/**
 * Fullscreen goal-achieved celebration (#145): the victory moment for the
 * Goals page's own 🏁 action. Presentation only — GoalsPage decides WHEN
 * this renders, and only from the server-confirmed PATCH response (#110's
 * rule: celebration belongs to the acting surface, and never before the
 * server agrees). Deliberately NO Undo in here: Reactivate lives on the
 * Hall of Fame shelf, the single control for it.
 */
export function VictoryOverlay({ goal, onClose }: { goal: Goal; onClose: () => void }) {
  const dialogRef = useModalFocus();

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Confetti choreography: a center burst, then two side cannons. Skipped
  // entirely under prefers-reduced-motion — the overlay itself is the
  // celebration then. Cleanup clears the pending cannons AND the canvas:
  // an Escape half a second in must not leave particles raining on an
  // overlay that is no longer there.
  useEffect(() => {
    // Decide once, up front (#152): celebrate()'s per-burst gate would skip
    // the cannons anyway, but scheduling timers for no-op bursts is noise.
    if (prefersReducedMotion()) return;
    celebrate({ particleCount: 160, spread: 100, origin: { y: 0.6 } });
    const cannons = [
      setTimeout(
        () => celebrate({ particleCount: 60, angle: 60, spread: 70, origin: { x: 0, y: 0.7 } }),
        250,
      ),
      setTimeout(
        () => celebrate({ particleCount: 60, angle: 120, spread: 70, origin: { x: 1, y: 0.7 } }),
        400,
      ),
    ];
    return () => {
      for (const cannon of cannons) clearTimeout(cannon);
      resetCelebration();
    };
  }, []);

  const delta = targetDelta(goal.targetDate, goal.resolvedAt);
  return createPortal(
    <div
      ref={dialogRef}
      tabIndex={-1}
      className="victory-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={`Goal achieved: ${goal.title}`}
    >
      <div className="victory-card">
        <div className="victory-heading">🏆 Goal achieved</div>
        <h1 className="victory-title">{goal.title}</h1>
        {goal.outcome && (
          <p className="victory-outcome">
            <strong>Measured by:</strong> {goal.outcome}
          </p>
        )}
        <div className="victory-stats">
          <span className="chip">
            ✓ {goal.doneCount}/{goal.taskCount} tasks
          </span>
          {goal.trackedMinutes14d > 0 && (
            <span className="chip">
              ⏱ {formatTrackedMinutes(goal.trackedMinutes14d)} in the final 14 days
            </span>
          )}
          {goal.resolvedAt && <span className="chip">🗓 {formatResolvedDate(goal.resolvedAt)}</span>}
          {delta && <span className="chip">{delta}</span>}
        </div>
      </div>
      <button className="primary victory-claim" onClick={onClose}>
        Claim victory
      </button>
      <div className="victory-hint">Esc closes — the goal moves to the Hall of Fame</div>
    </div>,
    // Portal target: outside #root so the root-level `inert` (useModalFocus)
    // cannot swallow the dialog itself.
    document.body,
  );
}
