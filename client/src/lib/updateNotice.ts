/**
 * Post-update notice (#272, ADR-70), behavior pinned in
 * lib/updateNotice.test.ts.
 *
 * The apply flow compares the authenticated server's canonical
 * `buildIdentity`. A replacement stamps a versioned, strictly validated
 * notice in sessionStorage before reloading, even when the package version
 * did not change. The Settings page consumes that tab-scoped value once.
 */

export const UPDATE_NOTICE_KEY = "draw.updateNotice";

export type BuildChannel = "stable" | "edge" | "local";

export type UpdateNotice =
  | {
      v: 1;
      kind: "sha";
      buildChannel: BuildChannel;
      buildSha: string;
    }
  | {
      v: 1;
      kind: "package";
      buildChannel: BuildChannel;
      current: string;
    };

const SHA_RE = /^[0-9a-f]{40}$/;
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const CHANNELS = new Set<BuildChannel>(["stable", "edge", "local"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function isBuildChannel(value: unknown): value is BuildChannel {
  return typeof value === "string" && CHANNELS.has(value as BuildChannel);
}

/** Serialize one of the two approved, versioned storage shapes. */
export function serializeUpdateNotice(notice: UpdateNotice): string {
  return JSON.stringify(notice);
}

/**
 * Parse only the exact approved storage shapes. Legacy bare versions,
 * arrays, extra keys, coercions, case changes, and trimmed field values all
 * fail closed.
 */
export function parseUpdateNotice(raw: string | null): UpdateNotice | null {
  if (raw === null) return null;

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value) || value.v !== 1 || !isBuildChannel(value.buildChannel)) return null;

  if (
    value.kind === "sha" &&
    hasExactKeys(value, ["buildChannel", "buildSha", "kind", "v"].sort()) &&
    typeof value.buildSha === "string" &&
    SHA_RE.test(value.buildSha)
  ) {
    return {
      v: 1,
      kind: "sha",
      buildChannel: value.buildChannel,
      buildSha: value.buildSha,
    };
  }

  if (
    value.kind === "package" &&
    hasExactKeys(value, ["buildChannel", "current", "kind", "v"].sort()) &&
    typeof value.current === "string" &&
    VERSION_RE.test(value.current)
  ) {
    return {
      v: 1,
      kind: "package",
      buildChannel: value.buildChannel,
      current: value.current,
    };
  }

  return null;
}

/** Exact Settings copy for a successfully consumed notice. */
export function formatUpdateNotice(notice: UpdateNotice): string {
  return notice.kind === "sha"
    ? `Updated to ${notice.buildChannel} build ${notice.buildSha.slice(0, 12)}`
    : `Updated to Draw ${notice.current} (${notice.buildChannel} build)`;
}

interface NoticeStorage {
  getItem(key: string): string | null;
  removeItem(key: string): void;
}

/**
 * Read once and remove every present value. A message is returned only when
 * parsing succeeded and removal completed; every storage failure is silent.
 */
export function consumeUpdateNotice(storage: NoticeStorage): string | null {
  try {
    const raw = storage.getItem(UPDATE_NOTICE_KEY);
    if (raw === null) return null;
    const notice = parseUpdateNotice(raw);
    storage.removeItem(UPDATE_NOTICE_KEY);
    return notice === null ? null : formatUpdateNotice(notice);
  } catch {
    return null;
  }
}

/** Reload only for a changed, non-null canonical server identity. */
export function shouldReloadAfterApply(
  startedBuildIdentity: string,
  polledBuildIdentity: string | null,
): boolean {
  return polledBuildIdentity !== null && polledBuildIdentity !== startedBuildIdentity;
}
