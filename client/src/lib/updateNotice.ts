/**
 * Post-update notice (#247), behavior pinned in lib/updateNotice.test.ts.
 *
 * The apply flow POSTs /api/update/apply, then polls GET /api/update every
 * 3s (up to 5 minutes). When `current` changes, the client stamps
 * sessionStorage with the NEW version and location.reload()s — the #193
 * service-worker path serves the new bundle. After the reload, the flag pays
 * exactly one "Updated to X" line and is consumed, so a second reload shows
 * nothing (no reload loops, no repeat toasts).
 *
 * Conventions copied from lib/deckScope.ts:
 * - The key is `draw.`-namespaced — storage is shared with anything on the
 *   origin — and sessionStorage (not local): the notice belongs to the tab
 *   that requested the update, and must not resurface days later.
 * - These functions are pure over the raw stored string, so the rules are
 *   unit-testable without a DOM or a storage stub. Every actual storage
 *   read/write/remove in the component stays inside try/catch — a lost
 *   notice must never break the app.
 */

export const UPDATE_NOTICE_KEY = "draw.updateNotice";

// What a stored notice must look like to be announced: a bare or v-prefixed
// semver triple, optionally with a prerelease suffix. Anything else in the
// slot — an unrelated writer, a stale format — is not ours to toast.
const VERSION_RE = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** What to stamp before reloading: the version the toast will announce. */
export function serializeUpdateNotice(version: string): string {
  return version.trim();
}

/**
 * The version to announce once, or null (nothing stored, blank, or garbage —
 * a corrupt flag must not toast gibberish). Callers remove the key after a
 * non-null read; that consumption is what prevents repeat toasts.
 */
export function parseUpdateNotice(raw: string | null): string | null {
  if (raw === null) return null;
  const value = raw.trim();
  if (!VERSION_RE.test(value)) return null;
  return value;
}

/**
 * The poll's one decision: reload only when the server now reports a
 * DIFFERENT version than the one the apply started from. A failed poll tick
 * (null — the container is mid-restart) is never a reason to reload.
 */
export function shouldReloadAfterApply(
  startedCurrent: string,
  polledCurrent: string | null,
): boolean {
  if (!polledCurrent) return false;
  return polledCurrent !== startedCurrent;
}
