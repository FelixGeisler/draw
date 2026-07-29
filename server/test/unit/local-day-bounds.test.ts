import { describe, expect, it } from "vitest";
import { localDayBounds } from "../../src/services/localDay.js";

// localDayBounds (#219): the half-open instant range of a local calendar day,
// used so SQL filters "today's rows" by comparing plain instants instead of
// date(..., 'localtime') — SQLite's C localtime cannot read the suite's
// pinned IANA TZ on Windows and disagreed with JS about "today" for the two
// hours after local midnight. The suite pins TZ=Europe/Berlin (vitest
// config), so the expected offsets here are Berlin's: +02:00 in summer,
// +01:00 in winter, and these tests are exact rather than tautological.

describe("localDayBounds", () => {
  it("brackets a summer day at Berlin's +02:00", () => {
    const { startIso, endIso } = localDayBounds("2026-07-30");
    expect(startIso).toBe("2026-07-29T22:00:00.000Z");
    expect(endIso).toBe("2026-07-30T22:00:00.000Z");
  });

  it("brackets a winter day at Berlin's +01:00", () => {
    const { startIso, endIso } = localDayBounds("2026-01-15");
    expect(startIso).toBe("2026-01-14T23:00:00.000Z");
    expect(endIso).toBe("2026-01-15T23:00:00.000Z");
  });

  it("gives the spring-forward day its true 23 hours", () => {
    // Berlin skips 02:00→03:00 on 2026-03-29: fixed-offset math would make
    // the day 24h and leak an hour of the next day into "today".
    const { startIso, endIso } = localDayBounds("2026-03-29");
    const hours = (Date.parse(endIso) - Date.parse(startIso)) / 3_600_000;
    expect(hours).toBe(23);
  });

  it("gives the fall-back day its true 25 hours", () => {
    const { startIso, endIso } = localDayBounds("2026-10-25");
    const hours = (Date.parse(endIso) - Date.parse(startIso)) / 3_600_000;
    expect(hours).toBe(25);
  });

  it("an instant just after local midnight falls INSIDE the day — the #219 window", () => {
    // 2026-07-30 00:11 Berlin is 2026-07-29T22:11Z: UTC still names the
    // previous day, which is exactly the two-hour window where the old
    // SQLite-vs-JS mix failed.
    const { startIso, endIso } = localDayBounds("2026-07-30");
    const instant = "2026-07-29T22:11:00.000Z";
    expect(instant >= startIso && instant < endIso).toBe(true);
  });
});
