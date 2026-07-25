import { describe, expect, it } from "vitest";
import {
  LoginRateLimiter,
  deriveSessionKey,
  parseCookies,
  signSession,
  timingSafeEqualStrings,
  verifySession,
} from "../../src/auth.js";

// The password gate's crypto and throttling primitives (#190, ADR-50).
// Wiring (401s, cookie flow, header auth) is covered by the integration
// suite; these tests pin the pure logic, with the clock injected where time
// matters.

describe("timingSafeEqualStrings", () => {
  it("accepts equal strings", () => {
    expect(timingSafeEqualStrings("hunter2", "hunter2")).toBe(true);
    expect(timingSafeEqualStrings("", "")).toBe(true);
    expect(timingSafeEqualStrings("päss wörd 🃏", "päss wörd 🃏")).toBe(true);
  });

  it("rejects different strings, including different lengths", () => {
    expect(timingSafeEqualStrings("hunter2", "hunter3")).toBe(false);
    expect(timingSafeEqualStrings("hunter2", "hunter22")).toBe(false);
    expect(timingSafeEqualStrings("hunter2", "")).toBe(false);
  });
});

describe("deriveSessionKey", () => {
  it("is deterministic — sessions survive a restart", () => {
    expect(deriveSessionKey("pin").equals(deriveSessionKey("pin"))).toBe(true);
  });

  it("changes with the password — rotation revokes outstanding cookies", () => {
    expect(deriveSessionKey("old").equals(deriveSessionKey("new"))).toBe(false);
  });
});

describe("session token sign/verify", () => {
  const key = deriveSessionKey("pin");
  const now = 1_700_000_000_000;

  it("round-trips an unexpired token", () => {
    const token = signSession(key, now + 1000);
    expect(verifySession(key, token, now)).toBe(true);
  });

  it("rejects an expired token", () => {
    const token = signSession(key, now - 1);
    expect(verifySession(key, token, now)).toBe(false);
  });

  it("rejects a token whose expiry was tampered forward", () => {
    const token = signSession(key, now - 1);
    const forged = `${now + 60_000}.${token.split(".")[1]}`;
    expect(verifySession(key, forged, now)).toBe(false);
  });

  it("rejects a tampered signature", () => {
    const token = signSession(key, now + 1000);
    const [payload, signature] = token.split(".");
    const flipped = (signature[0] === "0" ? "1" : "0") + signature.slice(1);
    expect(verifySession(key, `${payload}.${flipped}`, now)).toBe(false);
  });

  it("rejects a token signed with a different key", () => {
    const token = signSession(deriveSessionKey("other"), now + 1000);
    expect(verifySession(key, token, now)).toBe(false);
  });

  it("rejects malformed tokens", () => {
    for (const garbage of ["", "no-dot", ".", "123.", ".abc", "NaN.deadbeef", "12.34.sig"]) {
      expect(verifySession(key, garbage, now)).toBe(false);
    }
  });
});

describe("LoginRateLimiter", () => {
  const makeLimiter = () => {
    let nowMs = 0;
    const limiter = new LoginRateLimiter(3, 10_000, () => nowMs);
    return { limiter, advance: (ms: number) => (nowMs += ms) };
  };

  it("allows attempts until the limit, then blocks with a retry hint", () => {
    const { limiter } = makeLimiter();
    for (let i = 0; i < 3; i++) {
      expect(limiter.check("ip").allowed).toBe(true);
      limiter.recordFailure("ip");
    }
    const blocked = limiter.check("ip");
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMs).toBe(10_000);
  });

  it("counts down the retry hint and frees up when the window expires", () => {
    const { limiter, advance } = makeLimiter();
    for (let i = 0; i < 3; i++) limiter.recordFailure("ip");
    advance(4_000);
    expect(limiter.check("ip")).toEqual({ allowed: false, retryAfterMs: 6_000 });
    advance(6_000);
    expect(limiter.check("ip").allowed).toBe(true);
  });

  it("starts a fresh window when a failure lands after the old one expired", () => {
    const { limiter, advance } = makeLimiter();
    for (let i = 0; i < 3; i++) limiter.recordFailure("ip");
    advance(10_000);
    limiter.recordFailure("ip"); // 1 of 3 in the NEW window, not 4 of 3
    expect(limiter.check("ip").allowed).toBe(true);
  });

  it("clears on success", () => {
    const { limiter } = makeLimiter();
    for (let i = 0; i < 3; i++) limiter.recordFailure("ip");
    expect(limiter.check("ip").allowed).toBe(false);
    limiter.recordSuccess("ip");
    expect(limiter.check("ip").allowed).toBe(true);
  });

  it("tracks IPs independently", () => {
    const { limiter } = makeLimiter();
    for (let i = 0; i < 3; i++) limiter.recordFailure("attacker");
    expect(limiter.check("attacker").allowed).toBe(false);
    expect(limiter.check("owner").allowed).toBe(true);
  });
});

describe("parseCookies", () => {
  it("parses a cookie header", () => {
    expect(parseCookies("draw_session=abc.def; other=1")).toEqual({
      draw_session: "abc.def",
      other: "1",
    });
  });

  it("tolerates a missing header and junk fragments", () => {
    expect(parseCookies(undefined)).toEqual({});
    expect(parseCookies("junk; also-no-equals")).toEqual({});
  });
});
