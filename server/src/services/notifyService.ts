import { getSettingString } from "../db.js";
import { ACHIEVEMENTS } from "./gamificationService.js";
import { challengeState } from "./challengeService.js";

/**
 * Outbound notifications (#235, ADR-67): fire-and-forget POSTs to a
 * user-configured ntfy-compatible URL. The `notify_url` setting empty or
 * absent means OFF, and this module makes ZERO network calls.
 *
 * Rules:
 * - POST-COMMIT ONLY: callers are routes, invoking this after their write
 *   transaction has committed. A notification about a rolled-back unlock
 *   would be a lie, and a slow webhook must never hold a SQLite write lock.
 * - Fire-and-forget: nothing in the request path awaits the POST; a 3s abort
 *   caps the attempt, failures log one warning and are swallowed. The app
 *   must feel identical with a dead endpoint.
 * - ONE door: every send flows through notify() — a new event path has a
 *   single name to grep for (the R8 rule, same as payChallengeIfDue).
 *
 * Plain-text body with Title/Tags headers — the ntfy convention, which also
 * works verbatim against Gotify bridges and anything accepting raw POSTs.
 */

export interface NotifyEvent {
  title: string;
  body: string;
  /** ntfy Tags header (emoji shortcodes), e.g. "tada,trophy". */
  tags?: string;
}

/** Injectable for tests; production uses global fetch (Node >= 18). */
export type FetchLike = (url: string, init: RequestInit) => Promise<unknown>;
let fetchImpl: FetchLike = fetch;
export function setFetchForTests(f: FetchLike | null): void {
  fetchImpl = f ?? fetch;
}
/** The active implementation — the test route sends through the same one. */
export function currentFetch(): FetchLike {
  return fetchImpl;
}

export const NOTIFY_URL_SETTING = "notify_url";

export function notifyConfigured(): boolean {
  return Boolean(getSettingString(NOTIFY_URL_SETTING));
}

export function notify(event: NotifyEvent): void {
  const url = getSettingString(NOTIFY_URL_SETTING);
  if (!url) return; // off — zero calls, zero timers
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3_000);
  void Promise.resolve(
    fetchImpl(url, {
      method: "POST",
      headers: { Title: event.title, ...(event.tags ? { Tags: event.tags } : {}) },
      body: event.body,
      signal: controller.signal,
    }),
  )
    .catch((err: unknown) => {
      console.warn(`notify_url POST failed: ${err instanceof Error ? err.message : String(err)}`);
    })
    .finally(() => clearTimeout(timer));
}

/**
 * One POST for a batch of unlocks — a cascade (task + parent auto-complete)
 * must not burst the phone. Unknown keys render bare rather than dropping
 * the event: a future achievement still notifies before this map learns it.
 */
export function notifyUnlocks(keys: string[]): void {
  if (keys.length === 0) return;
  const lines = keys.map((key) => {
    const def = ACHIEVEMENTS.find((a) => a.key === key);
    return def ? `${def.emoji} ${def.title}` : key;
  });
  notify({
    title: keys.length === 1 ? "Achievement unlocked" : `${keys.length} achievements unlocked`,
    body: lines.join("\n"),
    tags: "trophy",
  });
}

export function notifyGoalAchieved(title: string): void {
  notify({ title: "Goal achieved", body: `🏆 ${title}`, tags: "tada" });
}

export function notifyChallengeCompleted(now: Date = new Date()): void {
  // Read-only label lookup; the payout row was already committed.
  const label = challengeState(now).label;
  notify({
    title: "Daily challenge complete",
    body: `✅ ${label} — +50 XP · +20 Gold`,
    tags: "dart",
  });
}
