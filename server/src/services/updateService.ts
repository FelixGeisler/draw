/**
 * OTA update check (#247), mirroring notifyService.ts.
 *
 * - Injectable fetch with its OWN module slot — never shared with
 *   notifyService's fetchImpl, or notify.test.ts and update.test.ts
 *   would interfere.
 * - One door: every outbound check flows through checkForUpdate(). The
 *   update_check_enabled setting (default ON; row "0" = off) gates EVERY
 *   call including the boot-timer tick — off means zero outbound calls,
 *   zero timers (the #235 rule).
 * - Check target: UPDATE_CHECK_URL env override (read at call time so tests
 *   and proxied networks can point it), default the GitHub latest-release
 *   endpoint. GET with `Accept: application/vnd.github+json`, 3s
 *   AbortController cap, parse `tag_name` + `html_url`. Failure = one
 *   console.warn, a degraded status (latest null, updateAvailable false),
 *   never a throw. The trigger bearer token NEVER rides this request — it
 *   authorizes restarting the app, and the check URL is not the trigger.
 * - Running version: the server's own package.json (resolveJsonModule is
 *   off, hence readFileSync), read once and memoized. The root package.json
 *   and mcpServer's literal are NOT sources of truth — pinned by the
 *   integration spec.
 * - First sighting of a NEW version sends ONE notification through the
 *   existing notify() door, then persists update_last_notified_version so
 *   re-checks and restarts never re-send.
 * - The apply trigger (update_trigger_url/_token) is written by
 *   routes/update.ts; both keys are secrets — presence flag only on read,
 *   excluded from GET /api/settings.
 *
 * Behavioral contract: test/integration/update.test.ts.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getSettingString, setSetting } from "../db.js";
import { isUpdateAvailable } from "../semver.js";
import { notify, notifyConfigured } from "./notifyService.js";

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

// In-memory cache of the last check — deliberately NOT persisted: a stale
// "update available" surviving the very restart that applied it would be a
// lie. A fresh boot answers latest/checkedAt null until the first check.
let cachedVersion: string | null = null;
let latestSeen: string | null = null;
let latestReleaseUrl: string | null = null;
let lastCheckedAt: string | null = null;

/** The server's own package.json version, read once and memoized. */
export function appVersion(): string {
  if (cachedVersion === null) {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(
      fs.readFileSync(path.resolve(here, "../../package.json"), "utf-8"),
    ) as { version: string };
    cachedVersion = String(pkg.version);
  }
  return cachedVersion;
}

/** Default ON — only an explicit "0" row turns the check off. */
export function updateCheckEnabled(): boolean {
  return getSettingString(UPDATE_CHECK_ENABLED_SETTING) !== "0";
}

export function applyConfigured(): boolean {
  return Boolean(getSettingString(UPDATE_TRIGGER_URL_SETTING));
}

/** Current cached state — NO network. What GET /api/update serves. */
export function updateStatus(): UpdateStatus {
  const current = appVersion();
  return {
    current,
    latest: latestSeen,
    updateAvailable: latestSeen !== null && isUpdateAvailable(current, latestSeen),
    releaseUrl: latestReleaseUrl,
    checkedAt: lastCheckedAt,
    checkEnabled: updateCheckEnabled(),
    applyConfigured: applyConfigured(),
  };
}

// First sighting of a new version: one notification, deduped through the
// update_last_notified_version settings row so re-checks and restarts never
// re-send. Marked only when a notify_url is configured — a sighting nobody
// could be told about must not consume the one send.
function notifyNewVersionOnce(): void {
  if (latestSeen === null) return;
  if (!isUpdateAvailable(appVersion(), latestSeen)) return;
  if (!notifyConfigured()) return;
  if (getSettingString(UPDATE_LAST_NOTIFIED_SETTING) === latestSeen) return;
  setSetting(UPDATE_LAST_NOTIFIED_SETTING, latestSeen);
  notify({
    title: "Update available",
    body:
      `Draw ${latestSeen} is available — running ${appVersion()}.` +
      (latestReleaseUrl ? `\n${latestReleaseUrl}` : ""),
    tags: "arrow_up",
  });
}

/**
 * The one outbound door: gated by update_check_enabled, one GET, cache the
 * result in memory, notify on first sighting of a new version. Resolves to
 * the (possibly degraded) status; never rejects on network failure.
 */
export async function checkForUpdate(): Promise<UpdateStatus> {
  if (!updateCheckEnabled()) return updateStatus(); // off means zero calls
  const url = process.env.UPDATE_CHECK_URL || DEFAULT_UPDATE_CHECK_URL;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3_000);
  try {
    const response = (await fetchImpl(url, {
      method: "GET",
      headers: { Accept: "application/vnd.github+json" },
      signal: controller.signal,
    })) as { ok?: boolean; status?: number; json?: () => Promise<unknown> };
    if (!response?.ok || typeof response.json !== "function") {
      throw new Error(`release endpoint answered HTTP ${response?.status ?? "?"}`);
    }
    const release = (await response.json()) as { tag_name?: unknown; html_url?: unknown };
    latestSeen = typeof release.tag_name === "string" ? release.tag_name : null;
    latestReleaseUrl = typeof release.html_url === "string" ? release.html_url : null;
    notifyNewVersionOnce();
  } catch (err) {
    // Degrade, never throw: GitHub down or the Pi offline is a normal state.
    console.warn(
      `[update] check failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    latestSeen = null;
    latestReleaseUrl = null;
  } finally {
    clearTimeout(timer);
    lastCheckedAt = new Date().toISOString();
  }
  return updateStatus();
}

/**
 * Test hook: drop the in-memory cache (latest/checkedAt/memoized version) as
 * if the process restarted. The notification dedupe must survive this — it
 * lives in the update_last_notified_version settings row, not in memory.
 */
export function resetUpdateStateForTests(): void {
  cachedVersion = null;
  latestSeen = null;
  latestReleaseUrl = null;
  lastCheckedAt = null;
}
