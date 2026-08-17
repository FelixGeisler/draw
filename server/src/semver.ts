// Semver compare for the OTA update check (#247) — a pure, dependency-free
// module (the config.ts stance: no db, no fs, no app import) so the whole
// comparison table is unit-testable without a network or a clock.
//
// Behavioral contract: test/unit/semver.test.ts.
// - `v`-prefix tolerant on both sides ("v1.2.3" === "1.2.3").
// - Numeric fields, not lexicographic: 1.10.0 > 1.9.0, 1.2.10 > 1.2.9.
// - A prerelease precedes its release: 1.0.0-rc.1 < 1.0.0. Prerelease
//   identifiers follow semver §11 precedence (rc.10 > rc.9, alpha < beta).
// - isUpdateAvailable offers a prerelease ONLY when the running version is
//   itself a prerelease; a running version NEWER than latest (dev build)
//   is never an update; anything unparseable on either side is never an
//   update (a garbage tag must not light the banner).

export interface Semver {
  major: number;
  minor: number;
  patch: number;
  /** The dash-suffix identifiers ("rc.1"), or null for a stable release. */
  prerelease: string | null;
}

// Exactly a triple, optionally v-prefixed, optionally dash-suffixed with
// dot-separated identifiers. Anything else — "nightly", "1.2", "latest",
// "v1.2.3.4" — is not a version this check reasons about.
const SEMVER_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

/** Parse "1.2.3", "v1.2.3", "v1.2.3-rc.1"; null for anything else. */
export function parseSemver(raw: string): Semver | null {
  const m = SEMVER_RE.exec(raw.trim());
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] ?? null,
  };
}

// Semver §11: a version without a prerelease outranks one with; identifier
// lists compare left to right — numeric identifiers numerically (and below
// any alphanumeric one), alphanumeric ones lexically; a shorter list that is
// a prefix of a longer one ranks lower.
function comparePrerelease(a: string | null, b: string | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1; // release > its prerelease
  if (b === null) return -1;
  const as = a.split(".");
  const bs = b.split(".");
  for (let i = 0; i < Math.max(as.length, bs.length); i++) {
    const x = as[i];
    const y = bs[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xNumeric = /^\d+$/.test(x);
    const yNumeric = /^\d+$/.test(y);
    if (xNumeric && yNumeric) {
      const diff = Number(x) - Number(y);
      if (diff !== 0) return diff < 0 ? -1 : 1;
    } else if (xNumeric !== yNumeric) {
      return xNumeric ? -1 : 1; // numeric identifiers rank below alphanumeric
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/** Classic comparator sign: negative when a < b, 0 when equal, positive when a > b. */
export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) {
    // Deliberately loud: callers that may hold unparseable strings go through
    // isUpdateAvailable, which fails closed instead.
    throw new TypeError(`compareSemver: not a semver: ${JSON.stringify(!pa ? a : b)}`);
  }
  if (pa.major !== pb.major) return pa.major - pb.major;
  if (pa.minor !== pb.minor) return pa.minor - pb.minor;
  if (pa.patch !== pb.patch) return pa.patch - pb.patch;
  return comparePrerelease(pa.prerelease, pb.prerelease);
}

/**
 * The one decision the banner and the notification hang off: should `latest`
 * be offered as an update over the running `current`?
 */
export function isUpdateAvailable(current: string, latest: string): boolean {
  const cur = parseSemver(current);
  const next = parseSemver(latest);
  if (!cur || !next) return false; // fail closed — no banner off a garbage tag
  // Stable installs stay on the stable channel; only a prerelease runner is
  // offered prereleases (and the stable that closes them).
  if (next.prerelease !== null && cur.prerelease === null) return false;
  return compareSemver(current, latest) < 0;
}
