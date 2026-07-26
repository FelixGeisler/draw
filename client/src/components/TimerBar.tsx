import { useEffect, useState } from "react";
import { useCurrentTimer, useStopTimer } from "../hooks/useTimer";
import { useUpdateTask } from "../hooks/useTasks";
import { formatElapsed } from "../lib/time";

export function TimerBar() {
  const timer = useCurrentTimer();
  const stopTimer = useStopTimer();
  const updateTask = useUpdateTask();
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!timer.data) return;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [timer.data]);

  if (!timer.data) return null;
  const { entry, task } = timer.data;

  return (
    // Container styles live in index.css (.timer-bar) so the phone
    // breakpoint can compact and wrap them (#193).
    <div className="timer-bar">
      <span style={{ fontSize: 18 }}>⏱</span>
      {/* .timer-title, not an inline flex: 1 — the phone breakpoint has to
          give the title a real basis so the strip wraps under it instead of
          squeezing the title into a tower of characters (#193). */}
      <strong className="timer-title">{task.title}</strong>
      <span style={{ fontVariantNumeric: "tabular-nums", fontSize: 18 }}>
        {formatElapsed(entry.startedAt, now)}
      </span>
      {task.effortMinutes != null && (
        <span style={{ color: "var(--text-dim)", fontSize: 13 }}>est. {task.effortMinutes} min</span>
      )}
      <button onClick={() => stopTimer.mutate()}>Stop</button>
      <button
        className="primary"
        onClick={() =>
          // Completion closes the running entry server-side (ADR-12) — no
          // separate stop call, so ended_at always equals completed_at.
          updateTask.mutate({ id: task.id, status: "done" })
        }
      >
        ✓ Done
      </button>
    </div>
  );
}
