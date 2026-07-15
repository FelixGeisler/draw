import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Category, Task } from "../api/types";
import { focusClock } from "../lib/time";
import { TypeLine } from "./CardFrame";
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

  // Modal focus management (PR #105 review): focus moves INTO the dialog on
  // mount and back to the trigger on exit, and the app root is `inert` while
  // the overlay is open — the portal below keeps the overlay itself outside
  // the inert subtree. That inerts the covered page for keyboard AND pointer,
  // so Tab cycles the dialog's own controls only instead of blindly operating
  // invisible background buttons. `inert` is baseline in every evergreen
  // browser (Chrome 102+, Firefox 112+, Safari 15.5+) — this local-first
  // app's whole target range.
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const trigger = document.activeElement;
    const root = document.getElementById("root");
    root?.setAttribute("inert", "");
    dialogRef.current?.focus();
    return () => {
      // Un-inert BEFORE restoring — an inert element refuses focus.
      root?.removeAttribute("inert");
      // The trigger may be gone by exit time (✓ Done unmounts the action
      // row); restoring is best-effort, never a crash.
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus();
    };
  }, []);

  const clock = focusClock(task.effortMinutes, startedAt, now);

  return createPortal(
    <div
      ref={dialogRef}
      tabIndex={-1}
      className="focus-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={`Focus: ${task.title}`}
    >
      {/* The TCG frame's type line (#115) carries the category here too —
          deliberately the ONLY frame element the focus view adopts: focus
          mode is "the drawn card's essentials and the clock, nothing else"
          (#56), so the full frame chrome would fight its purpose while the
          shared pill keeps the visual language consistent. */}
      {category && <TypeLine category={category} />}
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
    </div>,
    // Portal target: outside #root so the root-level `inert` (above) cannot
    // swallow the dialog itself.
    document.body,
  );
}
