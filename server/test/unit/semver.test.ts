import { describe, expect, it } from "vitest";
import { compareSemver, isUpdateAvailable, parseSemver } from "../../src/semver.js";

// Semver compare for the OTA update check (#247). Pure table tests — no db,
// no fs, no clock. SPEC-FIRST: src/semver.ts is a TODO-throwing skeleton, so
// every test here is `it.fails` and passes BECAUSE the skeleton throws.
// WHEN IMPLEMENTING #247: flip every `it.fails` to `it` — an implemented
// function that satisfies the assertions makes `it.fails` itself fail, which
// is the reminder.

describe("parseSemver", () => {
  it.fails("parses a plain triple and tolerates the v prefix — GitHub tags are v-prefixed", () => {
    expect(parseSemver("1.2.3")).toEqual({ major: 1, minor: 2, patch: 3, prerelease: null });
    expect(parseSemver("v1.2.3")).toEqual({ major: 1, minor: 2, patch: 3, prerelease: null });
  });

  it.fails("captures the prerelease identifiers", () => {
    expect(parseSemver("v1.2.3-rc.1")).toEqual({
      major: 1,
      minor: 2,
      patch: 3,
      prerelease: "rc.1",
    });
  });

  it.fails("returns null for anything that is not a full semver triple", () => {
    // A repo can grow tags like "nightly-2026-08-01" — the check must treat
    // them as no-update, never as a crash or a bogus banner.
    for (const raw of ["", "nightly", "1.2", "1", "v1.2.3.4", "one.two.three", "latest"]) {
      expect(parseSemver(raw)).toBeNull();
    }
  });
});

describe("compareSemver", () => {
  it.fails("treats the same version as equal regardless of the v prefix", () => {
    expect(compareSemver("1.2.3", "1.2.3")).toBe(0);
    expect(compareSemver("v1.2.3", "1.2.3")).toBe(0);
    expect(compareSemver("1.2.3", "v1.2.3")).toBe(0);
  });

  it.fails("orders by major, then minor, then patch", () => {
    expect(compareSemver("2.0.0", "1.9.9")).toBeGreaterThan(0);
    expect(compareSemver("1.3.0", "1.2.9")).toBeGreaterThan(0);
    expect(compareSemver("1.2.4", "1.2.3")).toBeGreaterThan(0);
    expect(compareSemver("1.2.3", "1.2.4")).toBeLessThan(0);
  });

  it.fails("compares fields numerically, never lexicographically", () => {
    // The exact bug class the issue names: "1.10.0" < "1.9.0" as strings.
    expect(compareSemver("1.10.0", "1.9.0")).toBeGreaterThan(0);
    expect(compareSemver("1.2.10", "1.2.9")).toBeGreaterThan(0);
    expect(compareSemver("10.0.0", "9.0.0")).toBeGreaterThan(0);
  });

  it.fails("a prerelease precedes its release", () => {
    expect(compareSemver("1.0.0-rc.1", "1.0.0")).toBeLessThan(0);
    expect(compareSemver("1.0.0", "1.0.0-rc.1")).toBeGreaterThan(0);
  });

  it.fails("orders prerelease identifiers per semver precedence", () => {
    // Numeric identifiers compare numerically (rc.10 exists in the wild)…
    expect(compareSemver("1.0.0-rc.10", "1.0.0-rc.9")).toBeGreaterThan(0);
    // …alphanumeric ones lexically, and a prerelease chain is ordered.
    expect(compareSemver("1.0.0-alpha", "1.0.0-beta")).toBeLessThan(0);
    expect(compareSemver("1.0.0-beta.2", "1.0.0-beta.1")).toBeGreaterThan(0);
  });
});

describe("isUpdateAvailable", () => {
  it.fails("offers a newer stable release, v-prefix tolerant on both sides", () => {
    expect(isUpdateAvailable("1.0.0", "v1.0.1")).toBe(true);
    expect(isUpdateAvailable("v1.0.0", "1.1.0")).toBe(true);
    expect(isUpdateAvailable("v1.9.0", "v1.10.0")).toBe(true);
  });

  it.fails("the same version is never an update", () => {
    expect(isUpdateAvailable("1.0.0", "1.0.0")).toBe(false);
    expect(isUpdateAvailable("1.0.0", "v1.0.0")).toBe(false);
  });

  it.fails("a running version NEWER than latest (a dev build) is never an update", () => {
    // A checkout ahead of the last tag must not nag about "updating" backward.
    expect(isUpdateAvailable("1.1.0", "1.0.0")).toBe(false);
    expect(isUpdateAvailable("2.0.0-rc.1", "1.9.9")).toBe(false);
  });

  it.fails("never offers a prerelease to a stable running version", () => {
    // Stable installs stay on the stable channel, even when the prerelease
    // is numerically ahead.
    expect(isUpdateAvailable("1.0.0", "1.1.0-beta.1")).toBe(false);
    expect(isUpdateAvailable("1.0.0", "v2.0.0-rc.1")).toBe(false);
  });

  it.fails("offers newer prereleases and the closing stable to a prerelease runner", () => {
    expect(isUpdateAvailable("1.1.0-beta.1", "1.1.0-beta.2")).toBe(true);
    // The stable that supersedes the rc IS an update for the rc runner.
    expect(isUpdateAvailable("1.1.0-rc.1", "1.1.0")).toBe(true);
    expect(isUpdateAvailable("1.1.0-rc.1", "1.2.0")).toBe(true);
  });

  it.fails("anything unparseable on either side is never an update", () => {
    // A weird tag or a mangled package.json must fail closed: no banner,
    // no notification — just the degraded no-update state.
    expect(isUpdateAvailable("1.0.0", "nightly-2026-08-01")).toBe(false);
    expect(isUpdateAvailable("not-a-version", "1.0.0")).toBe(false);
    expect(isUpdateAvailable("", "")).toBe(false);
  });
});
