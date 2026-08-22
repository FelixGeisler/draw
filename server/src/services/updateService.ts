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
 *   AbortController cap, parse `tag_name` + `html_url`. Failure (network,
 *   non-2xx, or a reachable feed answering without a tag_name) = one
 *   console.warn, never a throw — and the sighting from the last SUCCESSFUL
 *   check is retained: a transient blip must not un-light a banner for a
 *   whole day. Only a fresh boot (or a successful check saying otherwise)
 *   answers latest null. The trigger bearer token NEVER rides this request —
 *   it authorizes restarting the app, and the check URL is not the trigger.
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

/**
 * Server-side floor between FORCED checks (POST /api/update/check): within
 * the window the route serves the cache instead of another outbound GET, so
 * a hammered button (or a curl loop) cannot burn GitHub's unauthenticated
 * 60-req/hr budget. The daily scheduler calls checkForUpdate() directly and
 * is not affected.
 */
export const FORCED_CHECK_MIN_INTERVAL_MS = 30_000;

/** The GET /api/update payload — also what checkForUpdate resolves to. */
export interface UpdateStatus {
  current: string;
  buildChannel: "stable" | "edge" | "local";
  buildSha: string | null;
  buildIdentity: string;
  latest: string | null;
  updateAvailable: boolean;
  releaseUrl: string | null;
  /** ISO timestamp of the last completed check attempt, null before any. */
  checkedAt: string | null;
  checkEnabled: boolean;
  applyConfigured: boolean;
  /**
   * The verdict of the most recent apply attempt: a trigger that ANSWERED
   * non-2xx (token typo'd, wrong URL) is remembered here so the polling
   * client can stop waiting instead of burning its five-minute budget.
   * Cleared on every new apply POST. Rejections (abort, network) stay null —
   * a Watchtower holding the connection while it swaps this very container
   * looks exactly like that, and must not be reported as failure.
   */
  lastApplyError: string | null;
}

// In-memory cache of the last check — deliberately NOT persisted: a stale
// "update available" surviving the very restart that applied it would be a
// lie. A fresh boot answers latest/checkedAt null until the first check.
let cachedVersion: string | null = null;
let latestSeen: string | null = null;
let latestReleaseUrl: string | null = null;
let lastCheckedAt: string | null = null;
let lastApplyError: string | null = null;

/** Written by routes/update.ts around the fire-and-forget trigger POST. */
export function setLastApplyError(message: string | null): void {
  lastApplyError = message;
}

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

export type BuildChannel = "stable" | "edge" | "local";

/** Exact, case-sensitive channel allow-list; unknown build inputs fail to local. */
export function normalizeBuildChannel(value: string | undefined): BuildChannel {
  const channel = value?.trim();
  return channel === "stable" || channel === "edge" || channel === "local"
    ? channel
    : "local";
}

/** A build SHA is usable only when it is one full ASCII hexadecimal commit ID. */
export function normalizeBuildSha(value: string | undefined): string | null {
  const sha = value?.trim() ?? "";
  return /^[0-9a-fA-F]{40}$/.test(sha) ? sha.toLowerCase() : null;
}

/** Current cached state — NO network. What GET /api/update serves. */
export function updateStatus(): UpdateStatus {
  const current = appVersion();
  const buildChannel = normalizeBuildChannel(process.env.DRAW_BUILD_CHANNEL);
  const buildSha = normalizeBuildSha(process.env.DRAW_BUILD_SHA);
  return {
    current,
    buildChannel,
    buildSha,
    buildIdentity: buildSha
      ? `${buildChannel}:${buildSha}`
      : `${buildChannel}:version-${current}`,
    latest: latestSeen,
    updateAvailable: latestSeen !== null && isUpdateAvailable(current, latestSeen),
    releaseUrl: latestReleaseUrl,
    checkedAt: lastCheckedAt,
    checkEnabled: updateCheckEnabled(),
    applyConfigured: applyConfigured(),
    lastApplyError,
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
    if (typeof release.tag_name !== "string") {
      // A reachable feed answering junk is a failed check, not "no update" —
      // the distinct message keeps it tellable from a network failure in logs.
      throw new Error("release endpoint answered without a tag_name");
    }
    latestSeen = release.tag_name;
    latestReleaseUrl = typeof release.html_url === "string" ? release.html_url : null;
    notifyNewVersionOnce();
  } catch (err) {
    // Degrade, never throw: GitHub down or the Pi offline is a normal state.
    // The last SUCCESSFUL sighting is deliberately retained — a lit banner
    // must not go dark for up to a day because one re-check blipped.
    console.warn(
      `[update] check failed: ${err instanceof Error ? err.message : String(err)}`,
    );
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
  lastApplyError = null;
}
