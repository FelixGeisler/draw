import { useEffect, useState } from "react";
import type { Category, Task } from "../api/types";
import { focusClock } from "../lib/time";
import "./FocusOverlay.css";

/**
 * Fullscreen focus mode (issue #56): the drawn card, the running clock, and
 * nothing else. Presentation only — DrawPage derives WHEN this renders
 * (lib/focusView.ts, ADR-29), and the in-face actions ARE the DrawPage
 * actions passed in: ✓ Done is the drawn card's complete (PATCH status:done,
 * entry closed server-side per ADR-12), ■ Stop is the plain timer stop. No
 * control here duplicates behavior — and there is deliberately no re-draw:
 * the draw stays a commitment (#88) even when the focus runs over.
 */
export function FocusOverlay({
  task,
  category,
  startedAt,
  onDone,
  onStop,
  onExit,
}: {
  task: Task;
  category: Category | null;
  startedAt: string;
  onDone: () => void;
  onStop: () => void;
  /** Escape: leave the VIEW only — the timer keeps running (TimerBar). */
  onExit: () => void;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onExit();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onExit]);

  const clock = focusClock(task.effortMinutes, startedAt, now);

  return (
    <div
      className="focus-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={`Focus: ${task.title}`}
    >
      {category && (
        <span className="chip">
          <span className="dot" style={{ background: category.color }} />
          {category.name}
        </span>
      )}
      <h1 className="focus-title">{task.title}</h1>
      <div className={`focus-clock ${clock.mode}`}>{clock.text}</div>
      <div className="focus-est">
        {clock.mode === "countdown" && `of ${task.effortMinutes} min estimated`}
        {/* Overrunning is allowed: the clock is display only, nothing is
            auto-stopped or auto-completed at zero. */}
        {clock.mode === "overtime" && `estimate was ${task.effortMinutes} min — finish at your pace`}
        {clock.mode === "countup" && "no estimate — counting up"}
      </div>
      <div className="focus-actions">
        <button className="primary" onClick={onDone}>
          ✓ Done
        </button>
        <button onClick={onStop}>■ Stop</button>
      </div>
      <div className="focus-hint">Esc exits the view — the timer keeps running</div>
    </div>
  );
}
