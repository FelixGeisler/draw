export type DrawView = "idle" | "revealed" | "focus";

/**
 * Focus mode is a derived view, never stored state (issue #56, ADR-29): the
 * fullscreen overlay shows exactly when the running timer points at the
 * drawn card. Both inputs are already server-persisted (current draw ADR-13,
 * timer entry 6.4), so a reload mid-focus re-derives straight back into the
 * overlay — and a timer that was stopped or moved to another task from
 * elsewhere (second tab) degrades gracefully to the plain revealed card
 * instead of a dead overlay counting down for nobody.
 *
 * `focusExited` is the one piece of session-local UI state: Escape peeks out
 * of the view without stopping the timer. It is deliberately not persisted —
 * while the timer runs on the drawn card, "working on this card" remains the
 * truthful state a fresh mount derives.
 */
export function resolveDrawView(
  drawnTaskId: number | null,
  timerTaskId: number | null,
  focusExited: boolean,
): DrawView {
  if (drawnTaskId == null) return "idle";
  if (timerTaskId === drawnTaskId && !focusExited) return "focus";
  return "revealed";
}
