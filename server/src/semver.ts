// Semver compare for the OTA update check (#247) — a pure, dependency-free
// module (the config.ts stance: no db, no fs, no app import) so the whole
// comparison table is unit-testable without a network or a clock.
//
// SPEC-FIRST SKELETON: the bodies below throw until #247's implementation
// lands. The behavioral contract lives in test/unit/semver.test.ts (written
// as it.fails — flip each to it when implementing):
//   - `v`-prefix tolerant on both sides ("v1.2.3" === "1.2.3").
//   - Numeric fields, not lexicographic: 1.10.0 > 1.9.0, 1.2.10 > 1.2.9.
//   - A prerelease precedes its release: 1.0.0-rc.1 < 1.0.0. Prerelease
//     identifiers follow semver §11 precedence (rc.10 > rc.9, alpha < beta).
//   - isUpdateAvailable offers a prerelease ONLY when the running version is
//     itself a prerelease; a running version NEWER than latest (dev build)
//     is never an update; anything unparseable on either side is never an
//     update (a garbage tag must not light the banner).

export interface Semver {
  major: number;
  minor: number;
  patch: number;
  /** The dash-suffix identifiers ("rc.1"), or null for a stable release. */
  prerelease: string | null;
}

function todo(): never {
  throw new Error("TODO(#247): not implemented yet — spec'd in server/test/unit/semver.test.ts");
}

/** Parse "1.2.3", "v1.2.3", "v1.2.3-rc.1"; null for anything else. */
export function parseSemver(raw: string): Semver | null {
  void raw;
  todo();
}

/** Classic comparator sign: negative when a < b, 0 when equal, positive when a > b. */
export function compareSemver(a: string, b: string): number {
  void a;
  void b;
  todo();
}

/**
 * The one decision the banner and the notification hang off: should `latest`
 * be offered as an update over the running `current`?
 */
export function isUpdateAvailable(current: string, latest: string): boolean {
  void current;
  void latest;
  todo();
}
