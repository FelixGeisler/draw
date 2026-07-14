import { useEffect, useState } from "react";
import { useCurrentTimer, useStopTimer } from "../hooks/useTimer";
import { useUpdateTask } from "../hooks/useTasks";

function formatElapsed(startedAt: string, now: number): string {
  const seconds = Math.max(0, Math.floor((now - new Date(startedAt).getTime()) / 1000));
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m >= 60) {
    const h = Math.floor(m / 60);
    return `${h}:${String(m % 60).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  return `${m}:${String(s).padStart(2, "0")}`;
}

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
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 14,
        padding: "10px 24px",
        background: "rgba(79, 140, 255, 0.12)",
        borderBottom: "1px solid var(--accent)",
      }}
    >
      <span style={{ fontSize: 18 }}>⏱</span>
      <strong style={{ flex: 1 }}>{task.title}</strong>
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
