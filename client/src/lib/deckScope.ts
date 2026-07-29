/**
 * Deck scope — "work mode" (#214).
 *
 * One category the whole app is narrowed to, remembered PER DEVICE. The Draw
 * page has always had category chips; they simply forgot on reload and scoped
 * only the next draw. This is the persistence layer for that control, not a
 * second grouping concept.
 *
 * Per device rather than in the `settings` table on purpose: with the app on a
 * Pi and both a phone and a desktop pointed at it, a server-side "current
 * mode" would mean switching on one silently switches the other. Keeping it in
 * localStorage is both the more useful behaviour and the one that does not
 * deepen the single-instance assumptions of R6.
 *
 * These functions are pure and take the raw stored string, so the rules are
 * unit-testable without a DOM or a storage stub.
 */

export const DECK_SCOPE_KEY = "draw.deckScope";

/** `undefined` is the whole deck — the same value the chips have always used. */
export type DeckScope = number | undefined;

/**
 * Resolve the stored value against the categories that actually exist.
 *
 * Anything unparseable, non-numeric, or naming a category that is gone
 * resolves to the whole deck. That last case is the one that matters: a
 * category can be deleted from Settings at any time, and a scope pinned to it
 * would otherwise leave the app filtered to nothing — an empty deck and an
 * empty task list, with no visible cause and the offending chip no longer
 * rendered to click off.
 *
 * `knownIds` empty is treated as "not loaded yet", NOT as "no categories
 * exist": the categories query resolves a tick after the first render, and
 * pruning against an empty list would drop a valid scope on every reload.
 */
export function resolveDeckScope(raw: string | null, knownIds: readonly number[]): DeckScope {
  if (raw == null || raw === "") return undefined;
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) return undefined;
  if (knownIds.length === 0) return id;
  return knownIds.includes(id) ? id : undefined;
}

/** What to write back; `null` means remove the key rather than store "undefined". */
export function serializeDeckScope(scope: DeckScope): string | null {
  return scope == null ? null : String(scope);
}
