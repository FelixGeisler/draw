/**
 * The standing drawn card is a derived view, never a mount-time snapshot
 * (issue #110, extending ADR-29's principle from the focus overlay to the
 * card itself): the server-persisted current draw (ADR-13) decides what the
 * DrawPage shows, continuously. Completing, snoozing, or deleting the drawn
 * task from ANY surface — TimerBar, Tasks page, MCP, a second tab — clears
 * the pointer server-side, and the next refetch of `["draw","current"]`
 * (mutation invalidation in-app; window focus or the 60s interval where no
 * invalidation fires) makes the card leave without a second ✓ Done.
 *
 * Two session-local exceptions, both deliberate:
 * - `shuffling`: the draw animation plays face-down and the reveal works off
 *   the mutation response (written through to the query cache on success),
 *   never off a refetch race.
 * - `editedOutOfDeck`: an on-page edit that pushed the card out of the deck
 *   (#88's sanctioned escape) forfeits the pointer — the server clears it
 *   lazily on the next GET — but the SESSION keeps the card with the resolve
 *   hint until it is completed, snoozed, or deleted here: the draw is a
 *   commitment, and an edit must not become a hidden re-roll. A reload (new
 *   session) derives the idle deck, matching the cleared pointer.
 */
export function resolveDrawnCard<T>(input: {
  /** true while the shuffle animation plays — the card stays face-down */
  shuffling: boolean;
  /** `["draw","current"]` data — undefined while the query has not settled */
  serverTask: T | null | undefined;
  /** the card as this page last wrote it (draw response, edit write-back) */
  sessionTask: T | null;
  /** an on-page edit made the card non-restorable — pointer forfeited (#88) */
  editedOutOfDeck: boolean;
  /**
   * The held card was resolved on another surface (#118) — see
   * `heldCardResolved`. Releases the hold below: there is nothing left to
   * commit to, so the page must fall back to the (cleared) pointer.
   */
  heldCardResolved?: boolean;
}): T | null {
  if (input.shuffling) return null;
  if (input.editedOutOfDeck && input.sessionTask && !input.heldCardResolved) {
    return input.sessionTask;
  }
  // Query not settled (first fetch, or errored): the session's own draw is
  // the only truth available — never blank out a card the user just drew.
  // Deliberately ranked ABOVE a released hold (#130): with heldCardResolved
  // true and serverTask undefined the card survives, because an unsettled
  // query is never a verdict — symmetric with heldCardResolved(undefined, …)
  // === false. (Believed unreachable: the hold only exists post-edit, by
  // which time ["draw","current"] has settled, and its data survives refetch
  // errors — but the precedence is a decision, not an accident.)
  if (input.serverTask === undefined) return input.sessionTask;
  return input.serverTask;
}

/** The shape `heldCardResolved` needs of a task — roots carry their children. */
interface HeldCandidate {
  id: number;
  status: string;
  subtasks?: { id: number; status: string }[];
}

/**
 * Has the held card (#88's session-local hold) been resolved elsewhere?
 *
 * Issue #118: the hold outlives the pointer by design — but the pointer is
 * also the ONLY thing the current-draw query can speak about, so once it is
 * forfeit that query says "null" whether the held task is still sitting there
 * unresolved or was completed/deleted from the TimerBar, the Tasks page, MCP
 * or a second tab. The hold therefore used to stand until a reload, and every
 * on-page resolution of a deleted card 404'd — a genuinely stuck card, the
 * exact residue #110 removed everywhere else.
 *
 * The tasks list is the one server view that still knows: it carries every
 * root with its non-archived children. Resolved means gone (deleted, or
 * archived away as a subtask) or no longer open (completed elsewhere) — the
 * same two facts that would have cleared the pointer had it survived. An
 * unsettled query (`undefined`) is never a verdict: releasing on a missing
 * answer would drop the card on any hiccup, which is precisely the hidden
 * re-roll #88 bans.
 */
export function heldCardResolved(
  tasks: HeldCandidate[] | undefined,
  heldId: number,
): boolean {
  if (tasks === undefined) return false;
  for (const task of tasks) {
    if (task.id === heldId) return task.status !== "open";
    for (const subtask of task.subtasks ?? []) {
      if (subtask.id === heldId) return subtask.status !== "open";
    }
  }
  return true;
}
