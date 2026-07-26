import { describe, expect, it } from "vitest";
import {
  DEFAULT_HOST,
  isLoopbackHost,
  lanExposureWarning,
  resolveApiPort,
  resolveHost,
  resolvePassword,
  resolveTrustProxy,
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
