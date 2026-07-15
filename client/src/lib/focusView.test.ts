import { describe, expect, it } from "vitest";
import { resolveDrawView } from "./focusView";

// The focus-restore decision (issue #56, ADR-29): pure function of the two
// server-persisted facts (current draw, running timer) plus the session-local
// Escape flag. DrawPage re-derives this every render — these tests pin that
// every combination lands somewhere sensible, never on a dead overlay.
describe("resolveDrawView", () => {
  it("no drawn card → idle, whatever the timer does", () => {
    expect(resolveDrawView(null, null, false)).toBe("idle");
    expect(resolveDrawView(null, 7, false)).toBe("idle");
    expect(resolveDrawView(null, 7, true)).toBe("idle");
  });

  it("drawn card without a running timer → plain revealed card", () => {
    expect(resolveDrawView(7, null, false)).toBe("revealed");
  });

  it("timer running on ANOTHER task → revealed, never a dead overlay", () => {
    // e.g. a second tab started a different task; the refetch collapses focus
    expect(resolveDrawView(7, 8, false)).toBe("revealed");
  });

  it("timer running on the drawn card → focus (also the reload restore)", () => {
    expect(resolveDrawView(7, 7, false)).toBe("focus");
  });

  it("Escape exited the view → revealed even while the timer keeps running", () => {
    expect(resolveDrawView(7, 7, true)).toBe("revealed");
  });
});
