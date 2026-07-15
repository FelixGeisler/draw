import { describe, expect, it } from "vitest";
import { elapsedSeconds, focusClock, formatDuration, formatElapsed } from "./time";

const T0 = Date.parse("2026-07-15T12:00:00.000Z");
const startedAt = new Date(T0).toISOString();
const at = (seconds: number) => T0 + seconds * 1000;

describe("formatDuration", () => {
  it("renders m:ss under an hour", () => {
    expect(formatDuration(0)).toBe("0:00");
    expect(formatDuration(9)).toBe("0:09");
    expect(formatDuration(59)).toBe("0:59");
    expect(formatDuration(600)).toBe("10:00");
    expect(formatDuration(3599)).toBe("59:59");
  });

  it("rolls over to h:mm:ss at the hour", () => {
    expect(formatDuration(3600)).toBe("1:00:00");
    expect(formatDuration(7325)).toBe("2:02:05");
  });

  it("clamps negatives to zero instead of rendering nonsense", () => {
    expect(formatDuration(-42)).toBe("0:00");
  });
});

describe("formatElapsed / elapsedSeconds", () => {
  it("counts up from the start timestamp (TimerBar's classic display)", () => {
    expect(formatElapsed(startedAt, at(0))).toBe("0:00");
    expect(formatElapsed(startedAt, at(75))).toBe("1:15");
    expect(formatElapsed(startedAt, at(3661))).toBe("1:01:01");
  });

  it("floors a start timestamp in the future at zero (clock skew)", () => {
    expect(elapsedSeconds(startedAt, at(-30))).toBe(0);
    expect(formatElapsed(startedAt, at(-30))).toBe("0:00");
  });
});

// The focus clock (issue #56) is DISPLAY ONLY: crossing zero changes what is
// rendered, never what runs — the timer is not stopped, the task is not
// completed. These tests pin the three faces and the exact flip point.
describe("focusClock", () => {
  it("counts down the effort estimate", () => {
    expect(focusClock(10, startedAt, at(0))).toEqual({ mode: "countdown", text: "10:00" });
    expect(focusClock(10, startedAt, at(30))).toEqual({ mode: "countdown", text: "9:30" });
    expect(focusClock(90, startedAt, at(0))).toEqual({ mode: "countdown", text: "1:30:00" });
  });

  it("still shows a countdown at exactly zero, overtime only past it", () => {
    expect(focusClock(10, startedAt, at(600))).toEqual({ mode: "countdown", text: "0:00" });
    expect(focusClock(10, startedAt, at(601))).toEqual({ mode: "overtime", text: "+0:01 over" });
  });

  it("counts the overrun up in a distinct overtime mode", () => {
    expect(focusClock(10, startedAt, at(600 + 151))).toEqual({
      mode: "overtime",
      text: "+2:31 over",
    });
    // an overrun past the hour keeps the h:mm:ss rollover
    expect(focusClock(10, startedAt, at(600 + 3661))).toEqual({
      mode: "overtime",
      text: "+1:01:01 over",
    });
  });

  it("degrades to a plain count-up when the estimate is missing", () => {
    // Cannot happen for a drawn card (the deck requires estimates), but the
    // timer state is generic — never render a bogus countdown from nothing.
    expect(focusClock(null, startedAt, at(95))).toEqual({ mode: "countup", text: "1:35" });
    expect(focusClock(undefined, startedAt, at(95))).toEqual({ mode: "countup", text: "1:35" });
  });
});
