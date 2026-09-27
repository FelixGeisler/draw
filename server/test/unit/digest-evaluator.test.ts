import { describe, expect, it } from "vitest";
import {
  digestWindow,
  evaluateDigestEligibility,
  inQuietHours,
  resolveWallMinute,
  type DigestTiming,
} from "../../src/push/digestEvaluator.js";

const timing = (overrides: Partial<DigestTiming> = {}): DigestTiming => ({
  sendTime: "09:00", timezone: "UTC", quietStart: null, quietEnd: null, ...overrides,
});

describe("daily digest wall-calendar evaluator", () => {
  it("uses a half-open three-hour window and remaining-lifetime TTL", () => {
    expect(evaluateDigestEligibility(timing(), new Date("2026-09-20T08:59:59.999Z"))).toBeNull();
    expect(evaluateDigestEligibility(timing(), new Date("2026-09-20T09:00:00.000Z"))?.ttl).toBe(10_800);
    expect(evaluateDigestEligibility(timing(), new Date("2026-09-20T09:00:00.999Z"))?.ttl).toBe(10_799);
    expect(evaluateDigestEligibility(timing(), new Date("2026-09-20T11:59:58.999Z"))?.ttl).toBe(1);
    expect(evaluateDigestEligibility(timing(), new Date("2026-09-20T11:59:59.001Z"))).toBeNull();
    expect(evaluateDigestEligibility(timing(), new Date("2026-09-20T12:00:00.000Z"))).toBeNull();
  });

  it("cuts the window at the next local day", () => {
    const value = timing({ sendTime: "23:00" });
    const window = digestWindow(value, new Date("2026-09-20T23:00:00Z"))!;
    expect(window.end.toISOString()).toBe("2026-09-21T00:00:00.000Z");
    expect(evaluateDigestEligibility(value, new Date("2026-09-20T23:59:58.500Z"))?.ttl).toBe(1);
    expect(evaluateDigestEligibility(value, new Date("2026-09-20T23:59:59.001Z"))).toBeNull();
  });

  it("advances a spring gap and chooses the first fold occurrence", () => {
    expect(resolveWallMinute("2026-03-08", "02:15", "America/New_York")?.toISOString())
      .toBe("2026-03-08T07:00:00.000Z");
    expect(resolveWallMinute("2026-11-01", "01:30", "America/New_York")?.toISOString())
      .toBe("2026-11-01T05:30:00.000Z");
    const fold = timing({ sendTime: "01:30", timezone: "America/New_York" });
    expect(evaluateDigestEligibility(fold, new Date("2026-11-01T05:30:00Z"))?.ttl).toBe(10_800);
    expect(evaluateDigestEligibility(fold, new Date("2026-11-01T06:30:00Z"))?.ttl).toBe(7_200);
  });

  it("delays for half-open ordinary and cross-midnight quiet hours without overriding them", () => {
    expect(inQuietHours("09:00", "09:00", "10:00")).toBe(true);
    expect(inQuietHours("10:00", "09:00", "10:00")).toBe(false);
    expect(inQuietHours("23:59", "22:00", "08:00")).toBe(true);
    expect(inQuietHours("08:00", "22:00", "08:00")).toBe(false);
    const delayed = timing({ quietStart: "09:00", quietEnd: "10:00" });
    expect(evaluateDigestEligibility(delayed, new Date("2026-09-20T09:59:59Z"))).toBeNull();
    expect(evaluateDigestEligibility(delayed, new Date("2026-09-20T10:00:00Z"))?.ttl).toBe(7_200);
    const missed = timing({ quietStart: "09:00", quietEnd: "12:00" });
    expect(evaluateDigestEligibility(missed, new Date("2026-09-20T11:59:59Z"))).toBeNull();
  });

  it("rejects invalid or absent zones and does not replay a missed date", () => {
    expect(evaluateDigestEligibility(timing({ timezone: null }), new Date("2026-09-20T09:00:00Z"))).toBeNull();
    expect(evaluateDigestEligibility(timing({ timezone: "No/Such_Zone" }), new Date("2026-09-20T09:00:00Z"))).toBeNull();
    expect(evaluateDigestEligibility(timing(), new Date("2026-09-21T08:00:00Z"))).toBeNull();
  });
});
