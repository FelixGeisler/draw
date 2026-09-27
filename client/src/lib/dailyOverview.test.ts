import { describe, expect, it } from "vitest";
import { selectOverviewTimezone } from "./dailyOverview";

function status(timezone: unknown) {
  return {
    available: false,
    reason: "not-production",
    mutationAllowed: false,
    mutationReason: "secure-transport-required",
    vapidPublicKey: null,
    maxDevices: 16,
    preferences: {
      hideDetails: false,
      leadDays: 1,
      sendTime: "09:00",
      timezone,
      quietStart: null,
      quietEnd: null,
    },
    devices: [],
  };
}

describe("daily overview timezone selection", () => {
  it("prefers a valid saved timezone", () => {
    expect(selectOverviewTimezone(status("Europe/Berlin"), "America/New_York"))
      .toEqual({ ok: true, timezone: "Europe/Berlin", source: "saved" });
  });

  it.each([
    ["null saved timezone", status(null)],
    ["invalid non-null saved timezone", status("Not/A_Zone")],
    ["malformed status response", { preferences: { timezone: "Europe/Berlin" } }],
    ["failed status response", null],
  ])("falls back to valid detection for %s", (_name, pushStatus) => {
    expect(selectOverviewTimezone(pushStatus, "Pacific/Auckland"))
      .toEqual({ ok: true, timezone: "Pacific/Auckland", source: "detected" });
  });

  it.each(["", " Europe/Berlin", "é", "A".repeat(129), "Not/A_Zone", null])(
    "rejects invalid detected timezone %j",
    (detected) => expect(selectOverviewTimezone(null, detected)).toEqual({ ok: false }),
  );
});
