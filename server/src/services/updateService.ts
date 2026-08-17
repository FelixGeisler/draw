/**
 * OTA update check (#247) — SPEC-FIRST SKELETON.
 *
 * The exported surface below is the contract the integration specs
 * (test/integration/update.test.ts) are written against; the TODO-throwing
 * bodies keep tsc green while the tests run as it.fails. Mirror
 * notifyService.ts when implementing:
 *
 * - Injectable fetch with its OWN module slot — never share notifyService's
 *   fetchImpl, or notify.test.ts and update.test.ts interfere.
 * - One door: every outbound check flows through checkForUpdate(). The
 *   update_check_enabled setting (default ON; row "0" = off) gates EVERY
 *   call including the boot-timer tick — off means zero outbound calls,
 *   zero timers (the #235 rule).
 * - Check target: UPDATE_CHECK_URL env override (read at call time so tests
 *   and proxied networks can point it), default the GitHub latest-release
 *   endpoint. GET with `Accept: application/vnd.github+json`, 3s
 *   AbortController cap, parse `tag_name` + `html_url`. Failure = one
 *   console.warn, a degraded status (latest null, updateAvailable false),
 *   never a throw. The trigger bearer token must NEVER ride this request.
 * - Running version: the server's own package.json (server/package.json —
 *   `path.resolve(here, "../../package.json")` from src/services/, the db.ts
 *   fileURLToPath idiom; resolveJsonModule is off), read once and memoized.
 * - First sighting of a NEW version (isUpdateAvailable true and latest !==
 *   update_last_notified_version) sends ONE notification through the
 *   existing notify() door — title + body naming both versions, releaseUrl
 *   in the body, an ntfy-convention tags value — then persists
 *   update_last_notified_version so restarts never re-send.
 * - The apply trigger (update_trigger_url/_token) is written by
 *   routes/update.ts; both keys are secrets — presence flag only on read,
 *   and BOTH must join the NOT IN (...) exclusion in routes/settings.ts
 *   (add placeholders AND bound args; the count is hand-maintained).
 */

/** Injectable for tests; production uses global fetch (Node >= 18). */
export type FetchLike = (url: string, init: RequestInit) => Promise<unknown>;
let fetchImpl: FetchLike = fetch;
export function setFetchForTests(f: FetchLike | null): void {
  fetchImpl = f ?? fetch;
}
/** The active implementation — the routes send through the same one. */
export function currentFetch(): FetchLike {
  return fetchImpl;
}

// Settings keys (existing key-value settings table — no migration).
export const UPDATE_CHECK_ENABLED_SETTING = "update_check_enabled";
export const UPDATE_TRIGGER_URL_SETTING = "update_trigger_url";
export const UPDATE_TRIGGER_TOKEN_SETTING = "update_trigger_token";
export const UPDATE_LAST_NOTIFIED_SETTING = "update_last_notified_version";

export const DEFAULT_UPDATE_CHECK_URL =
  "https://api.github.com/repos/FelixGeisler/draw/releases/latest";

/** The GET /api/update payload — also what checkForUpdate resolves to. */
export interface UpdateStatus {
  current: string;
  latest: string | null;
  updateAvailable: boolean;
  releaseUrl: string | null;
  /** ISO timestamp of the last completed check attempt, null before any. */
  checkedAt: string | null;
  checkEnabled: boolean;
  applyConfigured: boolean;
}

function todo(): never {
  throw new Error(
    "TODO(#247): not implemented yet — spec'd in server/test/integration/update.test.ts",
  );
}

/** The server's own package.json version, read once at boot. */
export function appVersion(): string {
  todo();
}

/** Current cached state — NO network. What GET /api/update serves. */
export function updateStatus(): UpdateStatus {
  todo();
}

/**
 * The one outbound door: gated by update_check_enabled, one GET, cache the
 * result in memory, notify on first sighting of a new version. Resolves to
 * the (possibly degraded) status; never rejects on network failure.
 */
export async function checkForUpdate(): Promise<UpdateStatus> {
  todo();
}

/**
 * Test hook: drop the in-memory cache (latest/checkedAt/memoized version) as
 * if the process restarted. The notification dedupe must survive this —
 * it lives in the update_last_notified_version settings row, not in memory.
 * Deliberately a no-op in the skeleton so spec beforeEach hooks run.
 */
export function resetUpdateStateForTests(): void {
  // no-op until implemented
}
