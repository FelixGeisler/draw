import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_BACKUP_RETENTION,
  DEFAULT_HOST,
  MAX_BACKUP_INTERVAL_HOURS,
  isLoopbackHost,
  lanExposureWarning,
  resolveApiPort,
  DEFAULT_UPDATE_CHECK_INTERVAL_HOURS,
  resolveBackupIntervalHours,
  resolveBackupRetention,
  resolveHost,
  resolvePassword,
  resolveTrustProxy,
  resolveUpdateCheckIntervalHours,
} from "../../src/config.js";

// Explicit env objects throughout — the resolvers must not fall back to the
// ambient process.env of the test runner.

describe("resolveHost", () => {
  it("defaults to loopback when HOST is unset", () => {
    expect(resolveHost({})).toBe("127.0.0.1");
    expect(DEFAULT_HOST).toBe("127.0.0.1");
  });

  it("honors an explicit HOST", () => {
    expect(resolveHost({ HOST: "0.0.0.0" })).toBe("0.0.0.0");
    expect(resolveHost({ HOST: "192.168.0.42" })).toBe("192.168.0.42");
  });

  it("treats empty or whitespace HOST as unset", () => {
    expect(resolveHost({ HOST: "" })).toBe(DEFAULT_HOST);
    expect(resolveHost({ HOST: "   " })).toBe(DEFAULT_HOST);
  });

  it("trims surrounding whitespace", () => {
    expect(resolveHost({ HOST: " 0.0.0.0 " })).toBe("0.0.0.0");
  });
});

describe("resolveApiPort", () => {
  it("defaults to 3001", () => {
    expect(resolveApiPort({})).toBe(3001);
  });

  it("honors API_PORT", () => {
    expect(resolveApiPort({ API_PORT: "3101" })).toBe(3101);
  });

  it("falls back on a non-numeric API_PORT", () => {
    expect(resolveApiPort({ API_PORT: "not-a-port" })).toBe(3001);
    expect(resolveApiPort({ API_PORT: "" })).toBe(3001);
  });

  it("ignores PORT — dev tooling injects it", () => {
    expect(resolveApiPort({ PORT: "9999" })).toBe(3001);
  });
});

describe("resolvePassword", () => {
  it("is unset by default — auth off (#190)", () => {
    expect(resolvePassword({})).toBeUndefined();
  });

  it("treats empty or whitespace DRAW_PASSWORD as unset", () => {
    expect(resolvePassword({ DRAW_PASSWORD: "" })).toBeUndefined();
    expect(resolvePassword({ DRAW_PASSWORD: "   " })).toBeUndefined();
  });

  it("honors DRAW_PASSWORD, trimming surrounding whitespace", () => {
    expect(resolvePassword({ DRAW_PASSWORD: "lan-pin" })).toBe("lan-pin");
    expect(resolvePassword({ DRAW_PASSWORD: " lan-pin\n" })).toBe("lan-pin");
  });
});

describe("resolveTrustProxy", () => {
  it("trusts nobody by default (#190)", () => {
    expect(resolveTrustProxy({})).toBe(false);
    expect(resolveTrustProxy({ TRUST_PROXY: "" })).toBe(false);
    expect(resolveTrustProxy({ TRUST_PROXY: "  " })).toBe(false);
  });

  it("parses booleans", () => {
    expect(resolveTrustProxy({ TRUST_PROXY: "true" })).toBe(true);
    expect(resolveTrustProxy({ TRUST_PROXY: "false" })).toBe(false);
  });

  it("parses a whole number as a hop count", () => {
    expect(resolveTrustProxy({ TRUST_PROXY: "1" })).toBe(1);
    expect(resolveTrustProxy({ TRUST_PROXY: "2" })).toBe(2);
  });

  it("passes a preset or subnet spec through to Express", () => {
    expect(resolveTrustProxy({ TRUST_PROXY: "loopback" })).toBe("loopback");
    expect(resolveTrustProxy({ TRUST_PROXY: "127.0.0.1, 10.0.0.0/8" })).toBe("127.0.0.1, 10.0.0.0/8");
  });
});

describe("isLoopbackHost", () => {
  it("treats loopback addresses and localhost as loopback", () => {
    for (const h of ["127.0.0.1", "127.0.0.2", "::1", "localhost", "LOCALHOST", " 127.0.0.1 "]) {
      expect(isLoopbackHost(h)).toBe(true);
    }
  });

  it("treats 0.0.0.0, `::`, and LAN addresses as non-loopback", () => {
    for (const h of ["0.0.0.0", "192.168.1.5", "10.0.0.3", "::"]) {
      expect(isLoopbackHost(h)).toBe(false);
    }
  });
});

describe("lanExposureWarning", () => {
  it("warns when bound off loopback with no password (#191, ADR-51)", () => {
    const warning = lanExposureWarning("0.0.0.0", undefined);
    expect(warning).toContain("0.0.0.0");
    expect(warning).toContain("DRAW_PASSWORD");
    expect(warning).toContain("ADR-50");
  });

  it("names the actual bind host — a specific LAN IP, not just 0.0.0.0", () => {
    expect(lanExposureWarning("192.168.1.5", undefined)).toContain("192.168.1.5");
  });

  it("is silent when a password is set — the gate covers the exposure", () => {
    expect(lanExposureWarning("0.0.0.0", "lan-pin")).toBeUndefined();
    expect(lanExposureWarning("192.168.1.5", "lan-pin")).toBeUndefined();
  });

  it("is silent on a loopback bind, password or not", () => {
    expect(lanExposureWarning("127.0.0.1", undefined)).toBeUndefined();
    expect(lanExposureWarning("localhost", undefined)).toBeUndefined();
    expect(lanExposureWarning("::1", "lan-pin")).toBeUndefined();
  });
});

describe("resolveBackupIntervalHours", () => {
  it("is disabled (0) by default — no scheduler, behavior unchanged (#194)", () => {
    expect(resolveBackupIntervalHours({})).toBe(0);
    expect(resolveBackupIntervalHours({ BACKUP_INTERVAL_HOURS: "" })).toBe(0);
    expect(resolveBackupIntervalHours({ BACKUP_INTERVAL_HOURS: "0" })).toBe(0);
  });

  it("honors a positive interval, fractional included", () => {
    expect(resolveBackupIntervalHours({ BACKUP_INTERVAL_HOURS: "24" })).toBe(24);
    expect(resolveBackupIntervalHours({ BACKUP_INTERVAL_HOURS: "0.5" })).toBe(0.5);
  });

  it("treats non-numeric or non-positive values as disabled", () => {
    expect(resolveBackupIntervalHours({ BACKUP_INTERVAL_HOURS: "nightly" })).toBe(0);
    expect(resolveBackupIntervalHours({ BACKUP_INTERVAL_HOURS: "-6" })).toBe(0);
    expect(resolveBackupIntervalHours({ BACKUP_INTERVAL_HOURS: "NaN" })).toBe(0);
  });

  describe("caps over-large intervals to avoid setInterval overflow", () => {
    // setInterval's delay is a signed 32-bit ms int; the cap is the largest
    // whole-hour interval that still fits (596h). Boundary must hold: at the cap
    // passes through untouched, just over clamps.
    afterEach(() => vi.restoreAllMocks());

    it("caps so intervalHours * 3_600_000 never exceeds 2147483647ms", () => {
      expect(MAX_BACKUP_INTERVAL_HOURS).toBe(596);
      expect(MAX_BACKUP_INTERVAL_HOURS * 60 * 60 * 1000).toBeLessThanOrEqual(2_147_483_647);
      expect((MAX_BACKUP_INTERVAL_HOURS + 1) * 60 * 60 * 1000).toBeGreaterThan(2_147_483_647);
    });

    it("passes the cap value and anything under it through unchanged", () => {
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      expect(resolveBackupIntervalHours({ BACKUP_INTERVAL_HOURS: String(MAX_BACKUP_INTERVAL_HOURS) })).toBe(
        MAX_BACKUP_INTERVAL_HOURS,
      );
      expect(resolveBackupIntervalHours({ BACKUP_INTERVAL_HOURS: "24" })).toBe(24);
      expect(err).not.toHaveBeenCalled();
    });

    it("clamps just-over-cap and monthly values, warning to stderr", () => {
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      expect(resolveBackupIntervalHours({ BACKUP_INTERVAL_HOURS: String(MAX_BACKUP_INTERVAL_HOURS + 1) })).toBe(
        MAX_BACKUP_INTERVAL_HOURS,
      );
      // 720h ("monthly") is the exact overflow the review flagged.
      expect(resolveBackupIntervalHours({ BACKUP_INTERVAL_HOURS: "720" })).toBe(MAX_BACKUP_INTERVAL_HOURS);
      expect(err).toHaveBeenCalledTimes(2);
      expect(err.mock.calls[0][0]).toContain("clamping");
    });
  });
});

describe("resolveUpdateCheckIntervalHours (#247)", () => {
  // Unlike BACKUP_INTERVAL_HOURS, this knob is default-ON.

  it("defaults to 24h when unset or blank — the check is on by default", () => {
    expect(resolveUpdateCheckIntervalHours({})).toBe(DEFAULT_UPDATE_CHECK_INTERVAL_HOURS);
    expect(DEFAULT_UPDATE_CHECK_INTERVAL_HOURS).toBe(24);
    expect(resolveUpdateCheckIntervalHours({ UPDATE_CHECK_INTERVAL_HOURS: "" })).toBe(24);
    expect(resolveUpdateCheckIntervalHours({ UPDATE_CHECK_INTERVAL_HOURS: "  " })).toBe(24);
  });

  it("an explicit 0 (or a negative) disables — zero timers, zero calls", () => {
    expect(resolveUpdateCheckIntervalHours({ UPDATE_CHECK_INTERVAL_HOURS: "0" })).toBe(0);
    expect(resolveUpdateCheckIntervalHours({ UPDATE_CHECK_INTERVAL_HOURS: "-6" })).toBe(0);
  });

  it("honors a positive interval, fractional included", () => {
    expect(resolveUpdateCheckIntervalHours({ UPDATE_CHECK_INTERVAL_HOURS: "12" })).toBe(12);
    expect(resolveUpdateCheckIntervalHours({ UPDATE_CHECK_INTERVAL_HOURS: "0.5" })).toBe(0.5);
  });

  it("garbage falls back to the DEFAULT, never to disabled", () => {
    // A default-on feature must not be silently switched off by a typo —
    // that would be a setting that lies (the warmup_every_hours lesson).
    expect(resolveUpdateCheckIntervalHours({ UPDATE_CHECK_INTERVAL_HOURS: "daily" })).toBe(24);
    expect(resolveUpdateCheckIntervalHours({ UPDATE_CHECK_INTERVAL_HOURS: "NaN" })).toBe(24);
  });

  it("clamps over-large intervals to the int32 setInterval cap", () => {
    // Same overflow class as BACKUP_INTERVAL_HOURS: > ~596h wraps to 1ms.
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(resolveUpdateCheckIntervalHours({ UPDATE_CHECK_INTERVAL_HOURS: "9999" })).toBe(
        MAX_BACKUP_INTERVAL_HOURS,
      );
      expect(err).toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
    }
  });
});

describe("resolveBackupRetention", () => {
  it("defaults to 7 when unset (#194)", () => {
    expect(resolveBackupRetention({})).toBe(DEFAULT_BACKUP_RETENTION);
    expect(DEFAULT_BACKUP_RETENTION).toBe(7);
    expect(resolveBackupRetention({ BACKUP_RETENTION: "" })).toBe(DEFAULT_BACKUP_RETENTION);
    expect(resolveBackupRetention({ BACKUP_RETENTION: "   " })).toBe(DEFAULT_BACKUP_RETENTION);
  });

  it("honors a positive integer count", () => {
    expect(resolveBackupRetention({ BACKUP_RETENTION: "3" })).toBe(3);
    expect(resolveBackupRetention({ BACKUP_RETENTION: "30" })).toBe(30);
  });

  it("falls back to the default on 0, negatives, fractionals, or garbage", () => {
    // Retention 0 would delete the archive the run just wrote — never honored.
    expect(resolveBackupRetention({ BACKUP_RETENTION: "0" })).toBe(DEFAULT_BACKUP_RETENTION);
    expect(resolveBackupRetention({ BACKUP_RETENTION: "-1" })).toBe(DEFAULT_BACKUP_RETENTION);
    expect(resolveBackupRetention({ BACKUP_RETENTION: "2.5" })).toBe(DEFAULT_BACKUP_RETENTION);
    expect(resolveBackupRetention({ BACKUP_RETENTION: "lots" })).toBe(DEFAULT_BACKUP_RETENTION);
  });
});
