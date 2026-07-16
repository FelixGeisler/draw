import type { Task } from "../api/types";

/**
 * Pure derivations for the daily hand's strip (#59, ADR-34). Render-time
 * logic only — no state, no DOM — so the two rules that actually carry design
 * weight are unit-testable in isolation.
 */

export type HandCardState =
  /** This card is the current draw — it is on the table right now. */
  | "in-play"
  /** The deck is idle: clicking plays this card. */
  | "playable"
  /** Another card is on the table. Playing this one would be a re-roll (#88),
   *  and POST /api/hand/play answers 409 — so the strip must not offer it. */
  | "locked";

/**
 * What a hand card can do right now. The whole #88 line in one function: at
 * most ONE card is ever on the table, and the only way to a different one is
 * to resolve the standing card — never to play over it.
 */
export function handCardState(
  taskId: number,
  currentTaskId: number | null,
  deckIdle: boolean,
): HandCardState {
  if (taskId === currentTaskId) return "in-play";
  return deckIdle ? "playable" : "locked";
}

/**
 * Minutes of work left in the strip. Sums what is STILL in the hand, not what
 * was dealt: the hand only shrinks (completing, snoozing or deleting a card
 * removes it server-side), so this reads as "what is left of today's plan"
 * against the budget. Unestimated cards cannot be dealt, so the `?? 0` is
 * only ever reached by a card that was edited after the deal — and it is
 * pruned on the next read anyway.
 */
export function handEffortMinutes(tasks: Pick<Task, "effortMinutes">[]): number {
  return tasks.reduce((sum, t) => sum + (t.effortMinutes ?? 0), 0);
}
