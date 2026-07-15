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
}): T | null {
  if (input.shuffling) return null;
  if (input.editedOutOfDeck && input.sessionTask) return input.sessionTask;
  // Query not settled (first fetch, or errored): the session's own draw is
  // the only truth available — never blank out a card the user just drew.
  if (input.serverTask === undefined) return input.sessionTask;
  return input.serverTask;
}
